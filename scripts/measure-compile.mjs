import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { browserExecutable, removeProfile } from './compile-bench-utils.mjs';

async function main() {

	const args = process.argv.slice( 2 );
	const option = ( name, fallback ) => args.includes( name ) ? args[ args.indexOf( name ) + 1 ] : fallback;
	const runs = Number( option( '--runs', '3' ) );
	const executablePath = browserExecutable( option( '--browser', process.env.CHROME_PATH ) );
	const backend = option( '--backend', 'wavefront' );
	const output = resolve( option( '--output', 'bench/results/compile' ) );
	if ( ! Number.isInteger( runs ) || runs < 1 || ! [ 'wavefront', 'mega' ].includes( backend ) ) throw new Error( 'Use --runs positive-integer and --backend wavefront|mega.' );
	await mkdir( output, { recursive: true } );
	const server = await createServer( { configFile: './vite.config.js', server: { host: '127.0.0.1', port: 5188, strictPort: true, hmr: false, watch: null } } );
	const results = [];
	const revision = execFileSync( 'git', [ 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim();
	await server.listen();
	try {

		for ( let run = 0; run < runs; run ++ ) {

			const selected = option( '--variant', '' );
			if ( selected && ! [ 'stable-buffers', 'baseline' ].includes( selected ) ) throw new Error( 'Use --variant stable-buffers|baseline.' );
			const order = selected ? [ selected ] : run % 2 ? [ 'stable-buffers', 'baseline' ] : [ 'baseline', 'stable-buffers' ];
			for ( const variant of order ) {

				const profile = await mkdtemp( join( tmpdir(), 'pathtracer-compile-' ) );
				let browser;
				try {

					browser = await puppeteer.launch( { executablePath, headless: true, userDataDir: profile, args: [ '--enable-unsafe-webgpu', '--no-first-run' ] } );
					const page = await browser.newPage();
					await page.evaluateOnNewDocument( () => {

						let seed = 123456789;
						Math.random = () => {

							seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0;
							return seed / 4294967296;

						};

					} );
					const messages = [];
					page.on( 'pageerror', error => messages.push( error.message ) );
					page.on( 'console', message => {

						if ( message.type() === 'error' ) messages.push( message.text() );

					} );
					const query = new URLSearchParams( { variant, backend, async: String( args.includes( '--async' ) ), resources: String( args.includes( '--resources' ) ), concurrency: option( '--concurrency', '4' ), 'expected-vendor': option( '--expected-vendor', '' ), 'power-preference': option( '--power-preference', 'high-performance' ) } );
					await page.goto( `http://127.0.0.1:5188/compileBench.html?${ query }`, { waitUntil: 'load', timeout: 120000 } );
					page.setDefaultTimeout( 180000 );
					const result = await page.evaluate( () => window.compileBench );
					await page.screenshot( { path: join( output, `${ backend }-${ run }-${ variant }.png` ) } );
					const { shaders, ...summary } = result;
					await writeFile( join( output, `${ backend }-${ run }-${ variant }-shaders.json` ), JSON.stringify( shaders, null, 2 ) );
					results.push( { run, revision, browser: await browser.version(), ...summary, shaders: shaders.map( shader => ( { phase: shader.phase, bytes: shader.bytes, hash: shader.hash } ) ), messages } );
					await writeFile( join( output, `${ backend }.json` ), JSON.stringify( results, null, 2 ) );
					console.log( JSON.stringify( { run, variant, adapter: result.adapter, setupMs: result.setupMs, materialCallMs: result.materialCallMs, materialReadyMs: result.materialReadyMs, firstFrameReadyMs: result.firstFrameReadyMs, secondInstanceMs: result.secondInstanceMs, table: result.tableReadback, image: result.image, secondImage: result.secondImage, syncComputeCalls: result.pipelines.filter( p => p.method === 'createComputePipeline' ).length, errors: [ ...result.errors, ...messages ] } ) );
					if ( result.errors.length || messages.length || ! result.tableReadback.nonzero || ! result.image.nonzero ) throw new Error( 'GPU validation or rendering failed.' );
					if ( result.resourceIsolation && ( ! result.resourceIsolation.preserved || ! result.resourceIsolation.changed ) ) throw new Error( 'Tracer resources are not isolated.' );

				} finally {

					await browser?.close();
					await removeProfile( profile );

				}

			}

		}

		const hashes = new Set( results.map( result => result.tableReadback.hash ) );
		if ( hashes.size !== 1 ) throw new Error( 'Turquin readback differs between variants/runs.' );
		if ( new Set( results.map( result => result.image.hash ) ).size !== 1 ) throw new Error( 'Path-traced output differs between variants/runs.' );
		if ( results.some( result => result.image.hash !== result.secondImage.hash ) ) throw new Error( 'Second tracer output differs.' );

	} finally {

		await server.close();

	}

}

main().catch( error => {

	console.error( error );
	process.exitCode = 1;

} );
