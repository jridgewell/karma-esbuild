import { runKarma } from "./test-utils";
import { assertEventually } from "pentf/assert_utils";
import { promises as fs } from "fs";
import path from "path";
import { onTeardown } from "pentf/runner";

export const description =
	"Rebuild all entry files on changing a shared dependency";
export async function run(config: any) {
	const { output, resetLog } = await runKarma(config, "watch-shared");

	await assertEventually(() => {
		return output.stdout.find(line => /2 tests completed/.test(line));
	});

	const filePath = path.join(
		__dirname,
		"fixtures",
		"watch-shared",
		"files",
		"dep1.js",
	);

	const content = await fs.readFile(filePath, "utf-8");
	const write = (content: string) => fs.writeFile(filePath, content, "utf-8");

	onTeardown(config, async () => {
		await write(content);
	});

	resetLog();
	await write(`export function foo() { return 2 }`);

	await assertEventually(() => {
		return output.stdout.find(line => /2 tests failed/.test(line));
	});

	resetLog();
	await write(content);
	await assertEventually(() => {
		return output.stdout.find(line => /2 tests completed/.test(line));
	});
}
