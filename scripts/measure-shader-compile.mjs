import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable, removeProfile } from './compile-bench-utils.mjs';
import { createHash } from 'node:crypto';

async function main() {

	const args = process.argv.slice( 2 );
	const option = ( name, fallback ) => args.includes( name ) ? args[ args.indexOf( name ) + 1 ] : fallback;
	const output = resolve( option( '--output', 'bench/results/compile/raw' ) );
	const source = option( '--source', 'bench/results/compile/wavefront-0-stable-buffers-shaders.json' );
	const runs = Number( option( '--runs', '3' ) );
	if ( ! Number.isInteger( runs ) || runs < 1 ) throw new Error( 'Use --runs positive-integer.' );
	const shaders = JSON.parse( await readFile( source, 'utf8' ) ).filter( shader => shader.phase !== 'second-instance' && shader.code.includes( '@compute' ) );
	if ( shaders.length === 0 ) throw new Error( 'No compute shaders in the source capture.' );
	const sourceHash = createHash( 'sha256' ).update( JSON.stringify( shaders ) ).digest( 'hex' );
	await mkdir( output, { recursive: true } );
	const server = await createServer( { configFile: './vite.config.js', server: { host: '127.0.0.1', port: 5189, strictPort: true, hmr: false, watch: null } } );
	await server.listen();
	const results = [];
	try {

		for ( let run = 0; run < runs; run ++ ) {

			for ( const concurrency of run % 2 ? [ 4, 1 ] : [ 1, 4 ] ) {

				const profile = await mkdtemp( join( tmpdir(), 'pathtracer-raw-' ) );
				let browser;
				try {

					browser = await puppeteer.launch( { executablePath: browserExecutable( option( '--browser', process.env.CHROME_PATH ) ), headless: true, userDataDir: profile, args: [ '--enable-unsafe-webgpu', '--no-first-run' ] } );
					const page = await browser.newPage();
					await page.goto( 'http://127.0.0.1:5189/compileRaw.html' );
					const result = await page.evaluate( async ( shaders, concurrency, expectedVendor, powerPreference ) => {

						const adapter = await navigator.gpu.requestAdapter( { powerPreference } );
						if ( ! adapter ) throw new Error( 'WebGPU unavailable' );
						if ( expectedVendor && adapter.info.vendor !== expectedVendor ) throw new Error( `Expected ${ expectedVendor }, got ${ adapter.info.vendor }` );
						const device = await adapter.requestDevice( { requiredFeatures: [ ...adapter.features ], requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } } );
						const timings = [];
						let next = 0;
						const totalStart = performance.now();
						async function worker() {

							while ( next < shaders.length ) {

								const index = next ++;
								const shader = shaders[ index ];
								const code = shader.code;
								const begin = performance.now();
								const module = device.createShaderModule( { code } );
								try {

									await device.createComputePipelineAsync( { layout: 'auto', compute: { module, entryPoint: 'main' } } );

								} catch ( error ) {

									const info = await module.getCompilationInfo();
									throw new Error( `${ shader.bytes } bytes: ${ error.message }; ${ info.messages.map( m => m.message ).join( '; ' ) }` );

								}

								timings[ index ] = { phase: shader.phase, bytes: code.length, readyMs: performance.now() - begin };

							}

						}

						await Promise.all( Array.from( { length: concurrency }, worker ) );
						const totalMs = performance.now() - totalStart;
						const info = adapter.info;
						device.destroy();
						return { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, totalMs, timings };

					}, shaders, concurrency, option( '--expected-vendor', '' ), option( '--power-preference', 'high-performance' ) );
					results.push( { run, concurrency, source, sourceHash, browser: await browser.version(), ...result } );
					await writeFile( join( output, 'results.json' ), JSON.stringify( results, null, 2 ) );
					console.log( JSON.stringify( results.at( - 1 ) ) );

				} finally {

					await browser?.close();
					await removeProfile( profile );

				}

			}

		}

	} finally {

		await server.close();

	}

}

main().catch( error => {

	console.error( error );
	process.exitCode = 1;

} );
