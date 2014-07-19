/*****************************************************************************/
/* Imports */
/*****************************************************************************/
var Controller = Iron.Controller;
var Url = Iron.Url;
var MiddlewareStack = Iron.MiddlewareStack;

/*****************************************************************************/
/* RouteController */
/*****************************************************************************/
/**
 * Client specific initialization.
 */
RouteController.prototype.init = function (options) {
  this._computation = null;
};

/**
 * Let this controller run a dispatch process. This function will be called
 * from the router. That way, any state associated with the dispatch can go on
 * the controller instance.
 */
RouteController.prototype.dispatch = function (stack, url, done) {
  if (this._computation && !this._computation.stopped)
    throw new Error("RouteController computation is already running. Stop it first.");

  var controller = this;

  // break the computation chain with any parent comps
  Deps.nonreactive(function () {
    Deps.autorun(function (comp) {
      self._computation = comp;
      try {
        self._isInDispatch = true;
        stack.dispatch(url, controller, done);
      } finally {
        self._isInDispatch = false;
      }
    });
  });

  return this;
};

/**
 * Run a route. When the router runs its middleware stack, it can run regular
 * middleware functions or it can run a route. There should only one route
 * object per path as where there may be many middleware functions.
 *
 * For example:
 *
 *   "/some/path" => [middleware1, middleware2, route, middleware3]
 *
 * When a route is dispatched, it tells the controller to _runRoute so that
 * the controller can controll the process. At this point we should already be
 * in a dispatch so a computation should already exist.
 */
RouteController.prototype._runRoute = function (route, url, done) {
  var self = this;

  if (!this._isInDispatch)
    throw new Error("Can't call runRoute outside of a dispatch");

  if (this._computation.firstRun && !RouteController._hasJustReloaded) {
    this.runHooks('onRun', 'load');
    RouteController._hasJustReloaded = false;
  }

  if (!this._computation.firstRun) {
    this.runHooks('onRerun');
  }

  // see if there's a waitOn option we should process
  var waitOn = this.lookupOption('waitOn');

  // to simplify things waitOn should always be a function if it's defined.
  // if you're overriding a parent waitOn, you'll need to make it a function
  // that just returns undefined or something else.
  if (typeof waitOn !== 'undefined' && !_.isFunction(waitOn))
    throw new Error("waitOn must be a function");

  var waitOnResults;
  if (waitOn)
    waitOnResults = waitOn.call(this);

  if (typeof waitOnResults !== 'undefined') {
    waitOnResults = _.isArray(waitOnResults) ? waitOnResults : [waitOnResults];

    _.each(waitOnResults, function eachWaitOn (fnOrHandle) {
      self.wait(fnOrHandle);
    });
  }

  // start the rendering transaction so we record which regions were rendered
  // into so we can clear the unused regions later.
  this._layout.beginRendering();

  this.layout(this.lookupOption('layoutTemplate'), {
    data: this.lookupOption('data')
  });

  // dispatch into the "before" hook stack and the "action" stack making sure
  // the before stack comes first. this lets a before hook stop downstream
  // handlers by not calling this.next().
  var actionStack = new MiddlewareStack;
  var beforeHooks = this.collectHooks('onBeforeAction', 'before');
  actionStack.append(beforeHooks, {where: 'client'});

  // make sure the action stack has at least one handler on it that defaults
  // to the 'action' method
  if (route._actionStack.length === 0)
    route._actionStack.push(route._path, 'action', route.options);

  actionStack = actionStack.concat(route._actionStack);

  // the "context" is the current instance of the RouteController
  actionStack.dispatch(url, this, done);

  // run the after hooks. Note, at this point we're out of the middleware
  // stack way of doing things. So after actions don't call this.next(). They
  // run just like a regular hook. In contrast, before hooks have to call
  // this.next() to progress to the next handler, just like Connect
  // middleware.
  this.runHooks('onAfterAction', 'after');

  // clear any unused regions once we're done rendering. We put this in a
  // Deps.afterFlush so that rendered regions from {{#contentFor}} blocks in our
  // templates have a chance to register.
  Deps.afterFlush(function () {
    // if we're stopped don't do anything!
    if (self.isStopped)
      return;

    var usedRegions = self._layout.endRendering({flush: false});
    var allRegions = self._layout.regionKeys();
    var unusedRegions = _.difference(allRegions, usedRegions);
    _.each(unusedRegions, function (r) { self._layout.clear(r); });
  });
};

/**
 * The default action for the controller simply renders the main template.
 */
RouteController.prototype.action = function () {
  this.render();
};

/**
 * Returns the name of the main template for this controller. If no explicit
 * value is found we will guess the name of the template.
 */
RouteController.prototype.lookupTemplate = function () {
  return this.lookupOption('template') ||
    (this.router && this.router.toTemplateName(this.route.getName()));
};

/**
 * The regionTemplates for the RouteController.
 */
RouteController.prototype.lookupRegionTemplates = function () {
  return this.lookupOption('regionTemplates') || {};
};

/**
 * Overrides Controller.prototype.render to automatically render the
 * controller's main template and region templates or just render a region
 * template if the arguments are provided.
 */
RouteController.prototype.render = function (template, options) {
  if (arguments.length === 0) {
    var template = this.lookupTemplate();
    RouteController.__super__.render.call(this, template);
    this.renderRegions();
  } else {
    RouteController.__super__.render.call(this, template, options);
  }
};

/**
 * Render all region templates into their respective regions in the layout.
 */
RouteController.prototype.renderRegions = function () {
  var self = this;
  var regionTemplates = this.lookupOption('regionTemplates') || {};

  // regionTemplates =>
  //   {
  //     "MyTemplate": {to: 'MyRegion'}
  //   }
  _.each(regionTemplates, function (opts, templateName) {
    self.render(templateName, opts);
  });
};

/**
 * Stop the RouteController.
 */
RouteController.prototype.stop = function () {
  RouteController.__super__.stop.call(this);

  // if we started a rendering transaction, stop it now.
  this._layout.endRendering({flush: false});

  if (this._computation)
    this._computation.stop();
  this.runHooks('onStop', 'unload');
};

/**
 * Just proxies to the go method of router.
 *
 * It used to have more significance. Keeping because people are used to it.
 */
RouteController.prototype.redirect = function () {
  return this.router.go.apply(this.router, arguments);
};

if (Meteor._reload) {
  // just register the fact that a migration _has_ happened
  Meteor._reload.onMigrate('iron-router', function() { return [true, true]});
  
  // then when we come back up, check if it it's set
  var data = Meteor._reload.migrationData('iron-router');
  RouteController._hasJustReloaded = data;
}