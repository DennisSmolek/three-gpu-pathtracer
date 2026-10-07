/* global GPUDevice, GPUAdapter */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable, removeProfile } from './compile-bench-utils.mjs';

async function main() {

	const args = process.argv.slice( 2 );
	const option = ( name, fallback ) => args.includes( name ) ? args[ args.indexOf( name ) + 1 ] : fallback;
	const runs = Number( option( '--runs', '3' ) );
	if ( ! Number.isInteger( runs ) || runs < 1 ) throw new Error( 'Use --runs positive-integer.' );
	const output = resolve( option( '--output', 'bench/results/primitives' ) );
	await mkdir( output, { recursive: true } );
	const server = await createServer( { configFile: './vite.config.js', server: { host: '127.0.0.1', port: 5190, strictPort: true, hmr: false, watch: null } } );
	const results = [];
	await server.listen();
	try {

		for ( let run = 0; run < runs; run ++ ) {

			for ( const mode of run % 2 ? [ 'async', 'sync' ] : [ 'sync', 'async' ] ) {

				const profile = await mkdtemp( join( tmpdir(), 'pathtracer-example-' ) );
				let browser;
				try {

					browser = await puppeteer.launch( { executablePath: browserExecutable( option( '--browser', process.env.CHROME_PATH ) ), headless: true, userDataDir: profile, args: [ '--enable-unsafe-webgpu', '--no-first-run' ] } );
					const page = await browser.newPage();
					await page.setViewport( { width: 640, height: 480, deviceScaleFactor: 1 } );
					const errors = [];
					page.on( 'pageerror', error => errors.push( error.message ) );
					page.on( 'console', message => {

						if ( message.type() === 'error' && ! message.text().includes( '404' ) ) errors.push( message.text() );

					} );
					await page.evaluateOnNewDocument( () => {

						window.exampleAudit = { sync: 0, async: 0, frameGaps: [], errors: [], shaders: [] };
						const modules = new WeakMap();
						const createModule = GPUDevice.prototype.createShaderModule;
						GPUDevice.prototype.createShaderModule = function ( descriptor ) {

							const module = createModule.call( this, descriptor );
							modules.set( module, descriptor.code );
							return module;

						};

						for ( const [ method, key ] of [[ 'createComputePipeline', 'sync' ], [ 'createComputePipelineAsync', 'async' ]] ) {

							const original = GPUDevice.prototype[ method ];
							GPUDevice.prototype[ method ] = function ( ...args ) {

								window.exampleAudit[ key ] ++;
								window.exampleAudit.shaders.push( { method: key, phase: performance.getEntriesByName( 'pathtracer:ready' ).length ? 'render' : 'prepare', code: modules.get( args[ 0 ].compute.module ) } );
								return original.apply( this, args );

							};

						}

						const request = GPUAdapter.prototype.requestDevice;
						GPUAdapter.prototype.requestDevice = async function ( ...args ) {

							const device = await request.apply( this, args );
							window.exampleAudit.vendor = device.adapterInfo.vendor;
							device.addEventListener( 'uncapturederror', event => window.exampleAudit.errors.push( event.error.message ) );
							return device;

						};

						let last = performance.now();
						function frame( now ) {

							window.exampleAudit.frameGaps.push( now - last );
							last = now;
							requestAnimationFrame( frame );

						}

						requestAnimationFrame( frame );

					} );
					const start = Date.now();
					await page.goto( `http://127.0.0.1:5190/primitives.html?compile=${ mode }&bench`, { waitUntil: 'domcontentloaded', timeout: 120000 } );
					await page.waitForFunction( () => performance.getEntriesByName( 'pathtracer:ready' ).length, { timeout: 180000 } );
					const readyMs = Date.now() - start;
					await page.waitForFunction( () => performance.getEntriesByName( 'pathtracer:full-resolution-ready' ).length, { timeout: 180000 } );
					const firstFullResolutionMs = await page.evaluate( () => performance.getEntriesByName( 'pathtracer:full-resolution-ready' )[ 0 ].startTime );
					await page.evaluate( () => new Promise( resolve => {

						let frames = 0;
						function frame() {

							if ( ++ frames === 90 ) resolve();
							else requestAnimationFrame( frame );

						}

						requestAnimationFrame( frame );

					} ) );
					for ( const [ width, height, budget ] of [[ 480, 320, 1000 ], [ 800, 600, 5000 ], [ 640, 480, 250000 ]] ) {

						await page.setViewport( { width, height, deviceScaleFactor: 1 } );
						await page.evaluate( budget => {

							window.pathTracerBench.pathTracer.frameBudget = budget;

						}, budget );
						await page.evaluate( () => new Promise( resolve => {

							let frames = 0;
							function frame() {

								if ( ++ frames === 30 ) resolve();
								else requestAnimationFrame( frame );

							}

							requestAnimationFrame( frame );

						} ) );

					}

					const client = await browser.target().createCDPSession();
					const gpu = ( await client.send( 'SystemInfo.getInfo' ) ).gpu;
					const audit = await page.evaluate( () => window.exampleAudit );
					await page.screenshot( { path: join( output, `${ run }-${ mode }.png` ) } );
					results.push( { run, mode, browser: await browser.version(), gpu, readyMs, firstFullResolutionMs, ...audit, consoleErrors: errors } );
					await writeFile( join( output, 'results.json' ), JSON.stringify( results, null, 2 ) );
					console.log( JSON.stringify( { run, mode, readyMs, firstFullResolutionMs, sync: audit.sync, async: audit.async, maxFrameGap: Math.max( ...audit.frameGaps ), vendor: audit.vendor, errors: [ ...errors, ...audit.errors ] } ) );
					if ( errors.length || audit.errors.length || ( mode === 'async' && audit.sync ) ) throw new Error( 'Example validation failed.' );
					const expectedVendor = option( '--expected-vendor', '' );
					if ( expectedVendor && expectedVendor !== audit.vendor ) throw new Error( `Expected ${ expectedVendor }, got ${ audit.vendor }` );

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
