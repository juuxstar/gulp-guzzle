/**
 * Guzzle - better syntax for Gulp
 */
const gulp               = require('gulp');
const fs                 = require('fs');
const path               = require('path');
const Viz                = require('viz.js');
const { Module, render } = require('viz.js/full.render.js');
const _                  = require('lodash');
const clc                = require('cli-color');

const guzzleTasks = [];
let graphFilename;

const State = {
	NOT_STARTED: 'not_started',
	STARTED    : 'started',
	DONE       : 'done',
	ERROR      : 'error'
};

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
 * @param {Function} [options.onFinish] - is called every time there are no more tasks left to run (can occur multiple times due to watch)
 * @param {Boolean}  [options.prettyPrint] if true, uses a "different" display of tasks (experimental)
 */
const guzzle = module.exports = function(plugins, { taskGraph, onFinish, prettyPrint = false } = {}) {
	if (taskGraph) {
		graphFilename = taskGraph;
	}

	if (onFinish) {
		gulp.on('task_stop', _.debounce(() => {
			if (!_.some(gulp.tasks, t => t.running)) {
				onFinish();
			}
		}, 100));
	}

	gulp.on('task_start', event => {
		const task    = findGuzzleTask(event.task);
		task._state   = State.STARTED;
		task._started = new Date();
		if (prettyPrint) { printTasks(); }
	});

	gulp.on('task_stop', event => {
		const task = findGuzzleTask(event.task);
		if (task._state === State.DONE) return;
		task._state = State.DONE;
		task._ended = new Date();
		if (prettyPrint) { printTasks(); }
	});

	gulp.on('task_err', event => {
		findGuzzleTask(event.task)._state = State.ERROR;
		if (prettyPrint) { printTasks(); }
	});

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


/**
 * @param {Object} [options]
 * @param {Boolean} [options.runOnce] if true, task is only ever executed once
 */
guzzle.task = function(name, depends, doneCallback, options={}) {
	const { name, depends, doneCallback, options } = parseTaskArguments(...arguments)
	return new GuzzleTask(name, depends, doneCallback, options);
};

/**
 * A variant of guzzle.task that only runs once.
 */
guzzle.taskOnce = function(name, depends, doneCallback, options={}) {
	const { name, depends, doneCallback, options } = parseTaskArguments(...arguments);
	options.runOnce = true;
	return guzzle.task(name, depends, doneCallback, options);
}

guzzle.watch = gulp.watch.bind(gulp);

// Guzzle Task
class GuzzleTask {
	constructor(name, dependencies, onDoneFunction, { runOnce = false }={}) {
		this._name         = name;
		this._stream       = null;
		this._started      = null;
		this._state        = State.NOT_STARTED;
		this._runOnce      = runOnce;
		this._dependencies = dependencies.map(dependantTask => {
			// for any task dependencies not specified by name, assume they're sub-tasks and prepend parent task name
			if (dependantTask instanceof GuzzleTask) {
				dependantTask._name = `${this._name}.${dependantTask._name}`;
			}

			return dependantTask;
		});

		guzzleTasks.push(this);

		if (onDoneFunction) {
			this._onDoneFunction = callback => {
				if (this._runOnce && this._state !== State.NOT_STARTED) {
					return callback();
				}

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

async function outputTaskGraph() {
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

	const viz = new Viz({ Module, render });

	fs.writeFileSync(graphFilename, await viz.renderString(result.join('\n'), {
		format : path.extname(graphFilename).substr(1),
	}));
}

function findGuzzleTask(taskName) {
	return guzzleTasks.find(task => task._name === taskName);
}

function printTasks() {
	const now = new Date();
	const stateSymbols = {
		[State.NOT_STARTED]: '-',
		[State.STARTED]    : clc.yellow('?'),
		[State.DONE]       : clc.green.bold('✓'),
		[State.ERROR]      : clc.redBright('X')
	}

	// clear the screen and print out updated list of tasks
	process.stdout.write(
		'\033c\n'		// clears terminal
		+ guzzleTasks.map(task => {
			let elapsed = task._started ? (task._ended || now) - task._started : 0;
			elapsed     = elapsed > 1000 ? (Math.round(elapsed / 100) / 10) + 's' : elapsed + 'ms';
			return `${stateSymbols[task._state]} ${task._name} ${elapsed ? clc.blackBright(`(${elapsed})`) : ''}`;
		}).join('\n')
		+ '\n---\n'
	);
}

function parseTaskArguments(name, depends, doneCallback, options={}) {
	// check if called without any dependencies
	if (arguments.length === 2 && typeof depends === 'function') {
		doneCallback = depends;
		depends      = [];
	}

	if (!Array.isArray(depends)) {
		depends = [ depends ];
	}

	depends = _.compact(depends);

	return { name, depends, doneCallback, options};
}