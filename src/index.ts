import { debounce } from "./utils";
import { Bundler } from "./bundle";
import { TestEntryPoint } from "./test-entry-point";
import { MapDefault } from "./map-default";
import chokidar from "chokidar";
import * as path from "path";

import esbuild, { serve } from "esbuild";
import type karma from "karma";
import type { SourceMapPayload } from "module";
import type { IncomingMessage, ServerResponse } from "http";
import type { FSWatcher } from "chokidar";
import type { Log } from "./utils";

interface KarmaFile {
	originalPath: string;
	path: string;
	contentPath: string;
	/** This is a must for mapped stack traces */
	sourceMap?: SourceMapPayload;
	type: karma.FilePatternTypes;
}

type KarmaPreprocess = (
	content: any,
	file: KarmaFile,
	done: (err: Error | null, content?: string | null) => void,
) => void;

interface KarmaLogger {
	create(label: string): Log;
}

type BundlerFactory = (file: string) => Bundler;

function getBasePath(config: karma.ConfigOptions) {
	return config.basePath || process.cwd();
}

function createPreprocessor(
	config: karma.ConfigOptions & {
		esbuild?: { bundleDelay?: number } & Pick<esbuild.BuildOptions, "format">;
	},
	emitter: karma.Server,
	log: Log,
	testEntryPoint: TestEntryPoint,
	bundlerMap: MapDefault<string, Bundler>,
): KarmaPreprocess {
	const basePath = getBasePath(config);
	const { bundleDelay = 700, format } = config.esbuild || {};
	const bundler = bundlerMap.getOr(testEntryPoint.file);

	// Inject middleware to handle the bundled file and map.
	config.beforeMiddleware ||= [];
	config.beforeMiddleware.push("esbuild");

	// Create an empty file for Karma to track. Karma requires a real file in
	// order for it to be injected into the page, even though the middleware
	// will be responsible for serving it.
	if (!config.files) {
		config.files = [];
	}
	// Set preprocessor for our file to install sourceMap on it, giving Karma
	// the ability do unminify stack traces.
	config.preprocessors![testEntryPoint.file] = ["esbuild"];
	// For the sourcemapping to work, the file must be served by Karma, preprocessed, and have
	// the preproccessor attach a file.sourceMap.
	config.files.push({
		pattern: testEntryPoint.file,
		included: true,
		served: true,
		watched: false,
	});
	testEntryPoint.touch();

	let watcher: FSWatcher | null = null;
	const watchMode = !config.singleRun && !!config.autoWatch;
	if (watchMode) {
		// Initialize watcher to listen for changes in basePath so
		// that we'll be notified of any new files
		watcher = chokidar.watch([basePath], {
			ignoreInitial: true,
			// Ignore dot files and anything from node_modules
			ignored: /(^|[/\\])(\.|node_modules[/\\])/,
		});

		const alreadyWatched = config.files.reduce((watched: string[], file) => {
			if (typeof file === "string") {
				watched.push(file);
			} else if (file.watched) {
				watched.push(file.pattern);
			}
			return watched;
		}, []);
		watcher.unwatch(alreadyWatched);

		// Register shutdown handler
		emitter.on("exit", done => {
			watcher!.close();
			done();
		});

		const onWatch = debounce(() => {
			// Dirty the bundler first, to make sure we don't attempt to read an
			// already compiled result.
			bundler.dirty();
			emitter.refreshFiles();
		}, 100);
		watcher.on("change", onWatch);
		watcher.on("add", onWatch);
	}

	let stopped = false;
	emitter.on("exit", done => {
		stopped = true;
		bundler.stop().then(done);
	});

	const buildBundle = debounce(() => {
		// Prevent service closed message when we are still processing
		if (stopped) return;
		testEntryPoint.write();
		return bundler.write();
	}, bundleDelay);

	return async function preprocess(content, file, done) {
		// Karma likes to turn a win32 path (C:\foo\bar) into a posix-like path (C:/foo/bar).
		// Normally this wouldn't be so bad, but `bundler.file` is a true win32 path, and we
		// need to test equality.
		const filePath = path.normalize(file.originalPath);

		// If we're "preprocessing" the bundler file, all we need is to wait for
		// the bundle to be generated for it.
		if (filePath === testEntryPoint.file) {
			const item = await bundler.read();
			file.sourceMap = item.map;
			file.type = format === "esm" ? "module" : "js";
			done(null, item.code);
			return;
		}

		testEntryPoint.addFile(filePath);
		bundler.dirty();
		buildBundle();

		// Turn the file into a `dom` type with empty contents to get Karma to
		// inject the contents as HTML text. Since the contents are empty, it
		// effectively drops the script from being included into the Karma runner.
		file.type = "dom";
		done(null, "");
	};
}
createPreprocessor.$inject = [
	"config",
	"emitter",
	"karmaEsbuildLogger",
	"karmaEsbuildEntryPoint",
	"karmaEsbuildBundlerMap",
];

function createSourcemapMiddleware(
	testEntryPoint: TestEntryPoint,
	bundlerMap: MapDefault<string, Bundler>,
) {
	const testBundler = bundlerMap.getOr(testEntryPoint.file);
	return async function (
		req: IncomingMessage,
		res: ServerResponse,
		next: () => void,
	) {
		const match = /^(?:\/absolute)?([^?#]*?)(\.map)?(\?|#|$)/.exec(
			req.url || "",
		);
		if (!match) return next();

		const filePath = path.normalize(match[1]);
		const isMap = match[2] === ".map";

		if (!isModule(filePath)) return next();

		const bundler = bundlerMap.getOr(filePath);
		// Writing on the testBundler is handled by the preprocessor.
		if (bundler !== testBundler) bundler.write();

		const item = await bundler.read();
		if (isMap) {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(item.map, null, 2));
		} else {
			res.setHeader("Content-Type", "text/javascript");
			res.end(item.code);
		}
	};

	function isModule(filePath: string) {
		if (bundlerMap.has(filePath)) return true;
		for (const bundler of bundlerMap.values()) {
			if (bundler.modules.has(filePath)) {
				return true;
			}
		}

		return false;
	}

	async function serve(bundler: Bundler, isMap: boolean, res: ServerResponse) {}
}
createSourcemapMiddleware.$inject = [
	"karmaEsbuildEntryPoint",
	"karmaEsbuildBundlerMap",
];

function createEsbuildLog(logger: KarmaLogger) {
	return logger.create("esbuild");
}
createEsbuildLog.$inject = ["logger"];

function createEsbuildConfig(
	config: karma.ConfigOptions & {
		esbuild?: esbuild.BuildOptions & { bundleDelay?: number };
	},
) {
	const basePath = getBasePath(config);
	const { bundleDelay, ...userConfig } = config.esbuild || {};

	// Use some trickery to get the root in both posix and win32. win32 could
	// have multiple drive paths as root, so find root relative to the basePath.
	userConfig.outdir = path.resolve(basePath, "/");
	return userConfig;
}
createEsbuildConfig.$inject = ["config"];

function createEsbuildBundlerFactory(log: Log, config: esbuild.BuildOptions) {
	return function (file: string) {
		return new Bundler(file, log, config);
	};
}
createEsbuildBundlerFactory.$inject = [
	"karmaEsbuildLogger",
	"karmaEsbuildConfig",
];

function createTestEntryPoint() {
	return new TestEntryPoint();
}
createTestEntryPoint.$inject = [] as const;

function createBundlerMap(bundlerFactory: BundlerFactory) {
	return new MapDefault<string, Bundler>(bundlerFactory);
}
createBundlerMap.$inject = ["karmaEsbuildBundlerFactory"];

module.exports = {
	"preprocessor:esbuild": ["factory", createPreprocessor],
	"middleware:esbuild": ["factory", createSourcemapMiddleware],

	karmaEsbuildLogger: ["factory", createEsbuildLog],
	karmaEsbuildConfig: ["factory", createEsbuildConfig],
	karmaEsbuildBundlerMap: ["factory", createBundlerMap],
	karmaEsbuildBundlerFactory: ["factory", createEsbuildBundlerFactory],
	karmaEsbuildEntryPoint: ["factory", createTestEntryPoint],
};
