import * as path from "path";
import * as fs from "fs";
import * as esbuild from "esbuild";
import { Deferred, formatTime } from "./utils";

import type { Log } from "./utils";
import type { SourceMapPayload } from "module";
interface BundledFile {
	code: string;
	map: SourceMapPayload;
}

type BuildResult = esbuild.BuildIncremental & {
	outputFiles: esbuild.OutputFile[];
};

export class Bundler {
	private declare file: string;
	private declare log: Log;
	private declare config: esbuild.BuildOptions;

	// Dirty signifies that that the current result is stale, and a new build is
	// needed. It's reset during the next build.
	private _dirty = true;
	// buildsInProgress tracks the number of builds. When a build takes too
	// long, a new build may have started before the original completed. In this
	// case, we resolve the old build with the latest result.
	private buildsInProgress = 0;
	private deferred = new Deferred<BundledFile>();
	private incrementalBuild: esbuild.BuildIncremental | null = null;
	private startTime = 0;

	constructor(file: string, log: Log, config: esbuild.BuildOptions) {
		this.file = file;
		this.log = log;
		this.config = { ...config, entryPoints: [file] };
	}

	dirty() {
		if (this._dirty) return;
		this._dirty = true;
		this.deferred = new Deferred();
	}

	async write() {
		if (!this._dirty) return this.deferred.promise;
		if (this.buildsInProgress === 0) this.beforeProcess();
		this.buildsInProgress++;

		const { deferred } = this;
		const result = await this.bundle();

		// The build took so long, we've already had another write.
		// Instead of serving a stale build, let's wait for the new one to resolve.
		this.buildsInProgress--;
		if (this.buildsInProgress > 0 || this._dirty) {
			deferred.resolve(this.deferred.promise);
			return deferred.promise;
		}

		this.afterProcess();
		deferred.resolve(result);
		return result;
	}

	private beforeProcess() {
		this.startTime = Date.now();
		this.log.info(`Compiling to ${this.file}...`);
	}

	private afterProcess() {
		this.log.info(
			`Compiling done (${formatTime(Date.now() - this.startTime)})`,
		);
	}

	read() {
		return this.deferred.promise;
	}

	async stop() {
		// Wait for any in-progress builds to finish. At this point, we know no
		// new ones will come in, we're just waiting for the current one to
		// finish running.
		if (this.buildsInProgress > 0 || this._dirty) {
			await this.deferred.promise;
		}
		// Releasing the result allows the child process to end.
		this.incrementalBuild?.rebuild.dispose();
		this.incrementalBuild = null;
	}

	private async bundle() {
		try {
			this._dirty = false;
			if (this.incrementalBuild) {
				const result = await this.incrementalBuild.rebuild();
				return this.processResult(result as BuildResult);
			}

			const result = (await esbuild.build(this.config)) as BuildResult;
			this.incrementalBuild = result;

			return this.processResult(result);
		} catch (err) {
			this.log.error(err.message);

			return {
				code: `console.error(${JSON.stringify(err.message)})`,
				map: {} as SourceMapPayload,
			};
		}
	}

	private processResult(result: BuildResult) {
		const map = JSON.parse(result.outputFiles[0].text) as SourceMapPayload;
		const source = result.outputFiles[1].text;

		const basename = path.basename(this.file);
		const code = source + `\n//# sourceMappingURL=${basename}.map`;
		// outdir is guaranteed to be the root of the file system.
		const outdir = this.config.outdir!;
		map.sources = map.sources.map(s => path.join(outdir, s));
		map.file = basename;

		return { code, map };
	}
}
