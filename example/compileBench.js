/* global GPUDevice, GPUBufferUsage, GPUMapMode */
import { WebGPURenderer, Scene, PerspectiveCamera, Mesh, SphereGeometry, BoxGeometry, MeshPhysicalMaterial, Color, UniformNode, DataTexture, RGBAFormat, SpotLight } from 'three/webgpu';
import { WebGPUPathTracer } from '../src/webgpu/index.js';
import { ComputeKernel } from '../src/webgpu/compute/ComputeKernel.js';
import { GradientEquirectTexture } from '../src/index.js';

const options = new URLSearchParams( location.search );
const variant = options.get( 'variant' ) || 'stable-buffers';
const backend = options.get( 'backend' ) || 'wavefront';
const asyncPreparation = options.get( 'async' ) === 'true';
const modules = new WeakMap();
const pipelines = [];
const shaders = [];
const errors = [];
let phase = 'init';

const defineUniformAccessors = ComputeKernel.prototype.defineUniformAccessors;
ComputeKernel.prototype.defineUniformAccessors = function ( parameters ) {

	const result = defineUniformAccessors.call( this, parameters );
	for ( const key in parameters ) {

		const node = parameters[ key ];
		if ( node.isStorageBufferNode && node.name.startsWith( 'pt_' ) && variant === 'baseline' ) node.name = '';

	}

	return result;

};

const setName = UniformNode.prototype.setName;
UniformNode.prototype.setName = function ( name ) {

	if ( variant === 'baseline' && name.startsWith( 'pt_' ) ) return this;
	return setName.call( this, name );

};

async function digest( data ) {

	const bytes = await crypto.subtle.digest( 'SHA-256', data );
	return Array.from( new Uint8Array( bytes ), b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

}

// Instrument only this page's device. Every run uses a fresh browser profile.
const createModule = GPUDevice.prototype.createShaderModule;
GPUDevice.prototype.createShaderModule = function ( descriptor ) {

	const code = descriptor.code;

	const module = createModule.call( this, { ...descriptor, code } );
	const record = { phase, code, bytes: code.length };
	modules.set( module, record );
	shaders.push( record );
	return module;

};

for ( const method of [ 'createComputePipeline', 'createComputePipelineAsync', 'createRenderPipeline', 'createRenderPipelineAsync' ] ) {

	const original = GPUDevice.prototype[ method ];
	GPUDevice.prototype[ method ] = function ( descriptor ) {

		const begin = performance.now();
		const shader = modules.get( descriptor.compute?.module || descriptor.fragment?.module );
		const record = { phase, method, shader: shaders.indexOf( shader ), callMs: 0, readyMs: null };
		pipelines.push( record );
		const value = original.call( this, descriptor );
		record.callMs = performance.now() - begin;
		if ( value?.then ) return value.then( result => {

			record.readyMs = performance.now() - begin;
			return result;

		} );
		return value;

	};

}

async function readTexture( renderer, texture, depth = 1, bytesPerPixel = 16 ) {

	const device = renderer.backend.device;
	const expectedVendor = options.get( 'expected-vendor' );
	if ( expectedVendor && device.adapterInfo.vendor !== expectedVendor ) throw new Error( `Expected ${ expectedVendor }, got ${ device.adapterInfo.vendor }` );
	const width = texture.image.width;
	const height = texture.image.height;
	const rowBytes = Math.ceil( width * bytesPerPixel / 256 ) * 256;
	const size = rowBytes * height * depth;
	const buffer = device.createBuffer( { size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer( { texture: renderer.backend.get( texture ).texture }, { buffer, bytesPerRow: rowBytes, rowsPerImage: height }, [ width, height, depth ] );
	device.queue.submit( [ encoder.finish() ] );
	await buffer.mapAsync( GPUMapMode.READ );
	const data = new Uint8Array( buffer.getMappedRange() );
	const packed = new Uint8Array( width * height * depth * bytesPerPixel );
	for ( let row = 0; row < height * depth; row ++ ) packed.set( data.subarray( row * rowBytes, row * rowBytes + width * bytesPerPixel ), row * width * bytesPerPixel );
	buffer.unmap();
	buffer.destroy();
	return { hash: await digest( packed ), bytes: packed.length, nonzero: packed.some( b => b !== 0 ) };

}

async function run() {

	const renderer = new WebGPURenderer( { antialias: false, powerPreference: options.get( 'power-preference' ) || 'high-performance' } );
	await renderer.init();
	const device = renderer.backend.device;
	device.addEventListener( 'uncapturederror', event => errors.push( event.error.message ) );
	device.pushErrorScope( 'validation' );
	renderer.setSize( 64, 64 );
	document.body.appendChild( renderer.domElement );
	const scene = new Scene();
	scene.background = new Color( 0.15, 0.2, 0.3 );
	const environment = new GradientEquirectTexture();
	environment.topColor.set( 0xffffff );
	environment.bottomColor.set( 0x666666 );
	environment.update();
	scene.environment = environment;
	const colorMap = new DataTexture( new Uint8Array( [ 255, 128, 64, 255, 64, 128, 255, 255, 192, 255, 64, 255, 255, 64, 192, 255 ] ), 2, 2, RGBAFormat );
	colorMap.needsUpdate = true;
	const geometry = new SphereGeometry( 0.6, 16, 8 );
	const ball = new Mesh( geometry, new MeshPhysicalMaterial( { color: 0xc97e40, map: colorMap, roughness: 0.3, metalness: 0.5, clearcoat: 0.4 } ) );
	const ground = new Mesh( new BoxGeometry( 4, 0.1, 4 ), new MeshPhysicalMaterial( { color: 0xaaaaaa } ) );
	ground.position.y = - 0.7;
	scene.add( ball, ground );
	const light = new SpotLight( 0xffffff, 10 );
	light.position.set( 2, 3, 2 );
	light.iesMap = colorMap;
	scene.add( light );
	const camera = new PerspectiveCamera( 50, 1, 0.1, 100 );
	camera.position.set( 0, 1, 3 );
	camera.lookAt( 0, 0, 0 );
	phase = 'scene';
	const tracer = asyncPreparation ? await WebGPUPathTracer.createAsync( renderer, { useMegakernel: backend === 'mega' } ) : new WebGPUPathTracer( renderer );
	if ( backend === 'mega' && ! asyncPreparation ) tracer.useMegakernel( true );
	tracer.dynamicLowRes = false;
	tracer.renderDelay = 0;
	tracer.fadeDuration = 0;
	tracer.frameBudget = 4096;
	tracer.maxBounces = 3;
	tracer.maxSamples = 1;
	tracer.stableNoise = true;
	const setupStart = performance.now();
	if ( asyncPreparation ) {

		tracer.setScene( scene, camera );
		await tracer.compileAsync( { concurrency: Number( options.get( 'concurrency' ) || 4 ) } );

	} else {

		tracer.setScene( scene, camera );

	}

	const setupMs = performance.now() - setupStart;
	phase = 'material';
	const start = performance.now();
	if ( ! tracer.material.initialized ) tracer.material.init( renderer );
	tracer.material.initialized = true;
	const materialCallMs = performance.now() - start;
	await device.queue.onSubmittedWorkDone();
	const materialReadyMs = performance.now() - start;
	const table = tracer.material.turquinTexture;
	const tableReadback = await readTexture( renderer, table, table.image.depth, 8 );
	phase = 'first-frame';
	const first = performance.now();
	tracer.renderSample();
	await device.queue.onSubmittedWorkDone();
	const firstFrameReadyMs = performance.now() - first;
	phase = 'steady';
	const frameMs = [];
	for ( let i = 0; i < 24; i ++ ) {

		const begin = performance.now();
		tracer.renderSample();
		await device.queue.onSubmittedWorkDone();
		frameMs.push( performance.now() - begin );

	}

	const image = await readTexture( renderer, tracer._pathTracer.outputTarget );
	// Keep the first instance alive so identical programs can share the renderer's cache.
	phase = 'second-instance';
	const secondStart = performance.now();
	const second = asyncPreparation ? await WebGPUPathTracer.createAsync( renderer, { useMegakernel: backend === 'mega' } ) : new WebGPUPathTracer( renderer );
	if ( backend === 'mega' && ! asyncPreparation ) second.useMegakernel( true );
	second.dynamicLowRes = false;
	second.renderDelay = 0;
	second.fadeDuration = 0;
	second.frameBudget = 4096;
	second.maxBounces = 3;
	second.maxSamples = 1;
	second.stableNoise = true;
	second.setScene( scene, camera );
	if ( asyncPreparation ) await second.compileAsync( { concurrency: Number( options.get( 'concurrency' ) || 4 ) } );
	if ( ! second.material.initialized ) second.material.init( renderer );
	second.material.initialized = true;
	for ( let i = 0; i < 25; i ++ ) {

		second.renderSample();
		await device.queue.onSubmittedWorkDone();

	}

	const secondInstanceMs = performance.now() - secondStart;
	const secondImage = await readTexture( renderer, second._pathTracer.outputTarget );
	let resourceIsolation = null;
	if ( options.get( 'resources' ) === 'true' ) {

		phase = 'resource-isolation';
		const alternate = scene.clone();
		alternate.children[ 0 ].material = ball.material.clone();
		alternate.children[ 0 ].material.color.set( 0x2040ff );
		if ( asyncPreparation ) await second.setSceneAsync( alternate, camera );
		else second.setScene( alternate, camera );
		for ( let i = 0; i < 25; i ++ ) {

			second.renderSample();
			await device.queue.onSubmittedWorkDone();

		}

		const alternateImage = await readTexture( renderer, second._pathTracer.outputTarget );
		tracer.reset();
		for ( let i = 0; i < 25; i ++ ) {

			tracer.renderSample();
			await device.queue.onSubmittedWorkDone();

		}

		const originalImage = await readTexture( renderer, tracer._pathTracer.outputTarget );
		resourceIsolation = { alternateImage, originalImage, preserved: originalImage.hash === image.hash, changed: alternateImage.hash !== image.hash };

	}

	const validation = await device.popErrorScope();
	if ( validation ) errors.push( validation.message );
	for ( const shader of shaders ) {

		shader.hash = await digest( new TextEncoder().encode( shader.code ) );

	}

	const info = device.adapterInfo;
	const adapter = Object.fromEntries( [ 'vendor', 'architecture', 'device', 'description' ].map( key => [ key, info[ key ] ] ) );
	const result = { variant, backend, adapter, asyncPreparation, setupMs, materialCallMs, materialReadyMs, firstFrameReadyMs, tableReadback, image, secondImage, resourceIsolation, secondInstanceMs, frameMs, shaders, pipelines, errors };
	window.compileBenchResult = result;
	document.getElementById( 'status' ).textContent = JSON.stringify( { ...result, shaders: shaders.map( shader => ( { phase: shader.phase, bytes: shader.bytes, hash: shader.hash } ) ) }, null, 2 );
	return result;

}

window.compileBench = run().catch( error => {

	document.getElementById( 'status' ).textContent = error.stack;
	throw error;

} );
