import { debounce } from "./utils";
import { TestEntryPoint } from "./test-entry-point";
import { BundlerMap } from "./bundler-map";
import chokidar from "chokidar";
import * as path from "path";

import type esbuild from "esbuild";
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
	bundlerMap: BundlerMap,
): KarmaPreprocess {
	const basePath = getBasePath(config);
	const { bundleDelay = 700, format } = config.esbuild || {};
	const bundler = bundlerMap.getOrInitSync(testEntryPoint.file);

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
	// If we're "preprocessing" a bundle, then .
	if (filePath === testEntryPoint.file) {
		const bundler = await bundlerMap.getOrInit(filePath);
		const item = await bundler.read();
		file.sourceMap = item.map;
		file.type = format === "esm" ? "module" : "js";
		done(null, item.code);
		return;
	}

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
			bundlerMap.dirty();
			emitter.refreshFiles();
		}, 100);
		watcher.on("change", onWatch);
		watcher.on("add", onWatch);
	}

	let stopped = false;
	emitter.on("exit", done => {
		stopped = true;
		bundlerMap.stop().then(done);
	});

	const buildBundle = debounce(() => {
		// Prevent service closed message when we are still processing
		if (stopped) return;
		testEntryPoint.write();
		bundlerMap.sync();
		return bundler.write();
	}, bundleDelay);

	return async function preprocess(content, file, done) {
		// Karma likes to turn a win32 path (C:\foo\bar) into a posix-like path (C:/foo/bar).
		// Normally this wouldn't be so bad, but `bundler.file` is a true win32 path, and we
		// need to test equality.
		const filePath = path.normalize(file.originalPath);

		testEntryPoint.addFile(filePath);
		bundlerMap.dirty();
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

function createMiddleware(
	testEntryPoint: TestEntryPoint,
	bundlerMap: BundlerMap,
) {
	const testBundler = bundlerMap.getOrInitSync(testEntryPoint.file);
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

		if (!bundlerMap.has(filePath)) return next();

		const bundler = await bundlerMap.getOrInit(filePath);
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
}
createMiddleware.$inject = ["karmaEsbuildEntryPoint", "karmaEsbuildBundlerMap"];

function createEsbuildLog(logger: KarmaLogger) {
	return logger.create("esbuild");
}
createEsbuildLog.$inject = ["logger"];

function createTestEntryPoint() {
	return new TestEntryPoint();
}
createTestEntryPoint.$inject = [] as const;

function createBundlerMap(
	log: Log,
	karmaConfig: karma.ConfigOptions & {
		esbuild?: esbuild.BuildOptions & { bundleDelay?: number };
	},
) {
	const basePath = getBasePath(karmaConfig);
	const { bundleDelay, ...userConfig } = karmaConfig.esbuild || {};

	const define = {
		"process.env.NODE_ENV": JSON.stringify(
			process.env.NODE_ENV || "development",
		),
		...userConfig.define,
	};
	const plugin: esbuild.Plugin = {
		name: "module finder",
		setup: build => {
			build.onResolve({ filter: /./ }, args => {
				const filePath = path.resolve(args.resolveDir, args.path);
				bundlerMap.addPotential(filePath);
				return null;
			});
		},
	};
	const config: esbuild.BuildOptions = {
		target: "es2015",
		...userConfig,
		bundle: true,
		write: false,
		incremental: true,
		platform: "browser",
		sourcemap: "external",
		define,
		// Use some trickery to get the root in both posix and win32. win32 could
		// have multiple drive paths as root, so find root relative to the basePath.
		outdir: path.resolve(basePath, "/"),
		plugins: [plugin].concat(userConfig.plugins || []),
	};
	const bundlerMap = new BundlerMap(log, config);
	return bundlerMap;
}
createBundlerMap.$inject = ["karmaEsbuildLogger", "config"];

module.exports = {
	"preprocessor:esbuild": ["factory", createPreprocessor],
	"middleware:esbuild": ["factory", createMiddleware],

	karmaEsbuildLogger: ["factory", createEsbuildLog],
	karmaEsbuildBundlerMap: ["factory", createBundlerMap],
	karmaEsbuildEntryPoint: ["factory", createTestEntryPoint],
};
