import { $ } from 'bun';
import { rm } from 'node:fs/promises';

const DIST = 'dist';

await rm(DIST, { force: true, recursive: true });

const serverBuild = await Bun.build({
	entrypoints: [
		'src/ai/index.ts',
		'src/ai/client/index.ts',
		'src/ai/providers/anthropic.ts',
		'src/ai/providers/gemini.ts',
		'src/ai/providers/ollama.ts',
		'src/ai/providers/openai.ts',
		'src/ai/providers/openaiCompatible.ts',
		'src/ai/providers/openaiResponses.ts'
	],
	external: ['elysia'],
	outdir: DIST,
	root: 'src',
	sourcemap: 'linked',
	target: 'bun'
});

if (!serverBuild.success) {
	for (const log of serverBuild.logs) console.error(log);
	process.exit(1);
}

const browserBuild = await Bun.build({
	entrypoints: [
		'src/react/ai/index.ts',
		'src/vue/ai/index.ts',
		'src/svelte/ai/index.ts',
		'src/angular/ai/index.ts'
	],
	external: ['react', 'vue', 'svelte', '@angular/core'],
	outdir: DIST,
	root: 'src',
	sourcemap: 'linked',
	target: 'browser'
});

if (!browserBuild.success) {
	for (const log of browserBuild.logs) console.error(log);
	process.exit(1);
}

await $`tsc --emitDeclarationOnly --project tsconfig.build.json`;
