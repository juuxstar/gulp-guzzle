/**
 * Guzzle - better syntax for Gulp
 */
const gulp = require('gulp');
const fs   = require('fs');
const path = require('path');
const Viz  = require('viz.js');
const _    = require('lodash');

const guzzleTasks = [];
let graphFilename;

const oldStart = gulp.start;
gulp.start     = function() {
	makeGulpTasks();
	if (graphFilename) {
		outputTaskGraph();
	}
	oldStart.apply(gulp, arguments);
};

/**
 * Register gulp plugins.
 *
 * @param {Object} plugins              - keys are plugin names, values are plugins
 * @param {Object} [options]
 * @param {String} [options.taskGraph]  - if present, the name of the file to output a task graph in the format of the extension
 *                             (see https://github.com/mdaines/viz.js/wiki/API for available extensions/formats)
 * @param {Function} [options.onFinish] - is called everytime there are no more tasks left to run (can occur multiple times due to watch)
 */
const guzzle = module.exports = function(plugins, options) {
	options = options || {};

	if (options.taskGraph) {
		graphFilename = options.taskGraph;
	}

	if (options.onFinish) {
		gulp.on('task_stop', _.debounce(() => {
			if (!_.some(gulp.tasks, t => t.running)) {
				options.onFinish();
			}
		}, 100));
	}

	for (const name in plugins) {
		GuzzleTask.prototype[name] = makeGuzzlePlugin(plugins[name]);
	}

	function makeGuzzlePlugin(gulpPlugin) {
		return function() {
			this._stream = this._stream.pipe(gulpPlugin(...arguments));
			return this;
		};
	}
};

guzzle.task = function(name, depends, fn) {
	// check if called without any dependencies
	if (arguments.length === 2 && typeof depends == 'function') {
		fn      = depends;
		depends = [];
	}

	if (!Array.isArray(depends)) {
		depends = [ depends ];
	}

	const guzzleTask = new GuzzleTask(name, _.compact(depends), fn);
	guzzleTasks.push(guzzleTask);
	return guzzleTask;
};

guzzle.watch = gulp.watch.bind(gulp);

// Guzzle Task
class GuzzleTask {
	constructor(name, dependencies, onDoneFunction) {
		this._name         = name;
		this._stream       = null;
		this._dependencies = dependencies.map(dependantTask => {
			// for any task dependencies not specified by name, assume they're sub-tasks and prepend parent task name
			if (dependantTask instanceof GuzzleTask) {
				dependantTask._name = `${this._name}.${dependantTask._name}`;
			}

			return dependantTask;
		});

		if (onDoneFunction) {
			this._onDoneFunction = callback => {
				const result = onDoneFunction.call(this, callback);

				// reset stream in case the task is run again (via watch)
				if (this._stream) {
					this._stream.on('finish', () => {	// incase stream is a Writable
						this._stream = null;
					});
					this._stream.on('end', () => {		// incase stream is a Readable
						this._stream = null;
					});
				}

				return this._stream || result;	// prefer stream over result (even if result is a Promise)
			};
		}
	}

	read() {
		const oldStream = this._stream;
		const newStream = this._stream = gulp.src(...arguments);

		// if there was an existing stream, wait for it to finish before starting the new src stream
		if (oldStream) {
			newStream.pause();
			oldStream.on('finish', () => {
				newStream.resume();
			});
		}

		return this;
	}

	write() {
		this._stream = this._stream.pipe(gulp.dest(...arguments));
		return this;
	}

	pipe() {
		this._stream = this._stream.pipe(...arguments);
		return this;
	}

	on() {
		this._stream = this._stream.on(...arguments);
		return this;
	}
}

function makeGulpTasks() {
	guzzleTasks.forEach(guzzleTask => {
		// adjust dependencies
		guzzleTask._dependencies = guzzleTask._dependencies.map(dependantTask => {
			if (typeof dependantTask === 'string') {
				const task = _.find(guzzleTasks, { _name : dependantTask });
				if (!task) {
					throw new Error(`task not found: ${dependantTask}`);
				}
				dependantTask = task;
			}

			return dependantTask;
		});

		// define gulp task
		gulp.task(guzzleTask._name, _.map(guzzleTask._dependencies, '_name'), guzzleTask._onDoneFunction);
	});
}

function outputTaskGraph() {
	const result = [ 'digraph G {' ];

	guzzleTasks.forEach(guzzleTask => {
		const attr = _.map({
			shape : guzzleTask._dependencies.length ? 'box' : 'ellipse', // make "leaf" nodes in a different style
			style : guzzleTask._onDoneFunction ? 'solid' : 'dashed',
		}, (value, key) => `${key}=${value}`);

		result.push(`"${guzzleTask._name}" [${attr.join(',')}];`);	// make "leaf" nodes in a different style

		// add to task graph in DOT format
		if (guzzleTask._dependencies.length > 0) {
			guzzleTask._dependencies.forEach(dependency => {
				result.push(`"${guzzleTask._name}" -> "${dependency._name}";`);
			});
		}
	});

	result.push('}');

	fs.writeFileSync(graphFilename, Viz(result.join('\n'), {
		format : path.extname(graphFilename).substr(1),
	}));
}

