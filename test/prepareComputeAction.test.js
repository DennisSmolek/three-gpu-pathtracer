import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector2 } from 'three';
import { prepareComputeAction } from '../src/webgpu/compute/prepareComputeAction.js';

function fixture() {

	const events = [];
	const renderer = {
		init: async () => {},
		compileComputeAsync: async node => events.push( [ 'compile', node ] ),
		compute: node => events.push( [ 'compute', node.parameters?.layer?.value ] ),
		copyTextureToTexture: () => events.push( [ 'copy' ] ),
	};
	return { renderer, events };

}

test( 'replays changing uniforms, vector snapshots, dispatch sizes, copies and disposal in order', async () => {

	const { renderer, events } = fixture();
	const layer = { value: 0 };
	const point = { value: new Vector2() };
	const node = { parameters: { layer, point }, dispose: () => events.push( [ 'dispose' ] ) };
	const dispatch = [ 1, 1, 1 ];
	renderer.compute = ( node, size ) => events.push( [ 'dispatch', layer.value, point.value.x, size[ 0 ] ] );
	const result = await prepareComputeAction( renderer, () => {

		for ( let i = 0; i < 3; i ++ ) {

			layer.value = i;
			point.value.x = i;
			dispatch[ 0 ] = i + 1;
			renderer.compute( node, dispatch );
			if ( i === 0 ) renderer.copyTextureToTexture( {}, {} );

		}

		layer.value = 9;
		point.value.x = 9;
		node.dispose();
		return 'ready';

	} );
	assert.equal( result, 'ready' );
	assert.deepEqual( events.map( event => event[ 0 ] ), [ 'compile', 'dispatch', 'copy', 'dispatch', 'dispatch', 'dispose' ] );
	assert.deepEqual( events.filter( event => event[ 0 ] === 'dispatch' ), [[ 'dispatch', 0, 0, 1 ], [ 'dispatch', 1, 1, 2 ], [ 'dispatch', 2, 2, 3 ]] );
	assert.equal( layer.value, 9 );
	assert.equal( point.value.x, 9 );

} );

test( 'keeps a replaced resource alive through replay and releases it on compiler failure', async () => {

	for ( const fails of [ false, true ] ) {

		const { renderer } = fixture();
		let alive = true;
		let released = 0;
		const resource = { dispose: () => {

			alive = false; released ++;

		} };
		const originalDispose = resource.dispose;
		const node = { parameters: { target: { value: resource } } };
		renderer.compute = () => assert.equal( alive, true );
		if ( fails ) renderer.compileComputeAsync = async () => {

			throw new Error( 'compiler' );

		};

		const prepare = prepareComputeAction( renderer, () => {

			renderer.compute( node );
			resource.dispose();
			assert.equal( alive, true );

		} );
		if ( fails ) await assert.rejects( prepare, /compiler/ );
		else await prepare;
		assert.equal( resource.dispose, originalDispose );
		assert.equal( released, 1 );

	}

} );

test( 'restores methods and ownership after setup failure and rejects overlapping actions', async () => {

	const { renderer } = fixture();
	const compute = renderer.compute;
	const copy = renderer.copyTextureToTexture;
	await assert.rejects( prepareComputeAction( renderer, () => {

		throw new Error( 'setup' );

	} ), /setup/ );
	assert.equal( renderer.compute, compute );
	assert.equal( renderer.copyTextureToTexture, copy );
	await assert.rejects( prepareComputeAction( renderer, () => Promise.resolve() ), /synchronous action/ );
	let release;
	renderer.compileComputeAsync = () => new Promise( resolve => {

		release = resolve;

	} );
	const pending = prepareComputeAction( renderer, () => renderer.compute( { parameters: {} } ) );
	await new Promise( resolve => setImmediate( resolve ) );
	await assert.rejects( prepareComputeAction( renderer, () => {} ), /already active/ );
	release();
	await pending;
	await prepareComputeAction( renderer, () => {} );

} );

test( 'bounds independent compilation and preserves dispatch order', async () => {

	const { renderer } = fixture();
	let active = 0;
	let maximum = 0;
	const dispatched = [];
	renderer.compileComputeAsync = async () => {

		active ++;
		maximum = Math.max( maximum, active );
		await new Promise( resolve => setTimeout( resolve, 5 ) );
		active --;

	};

	renderer.compute = node => dispatched.push( node.index );
	await prepareComputeAction( renderer, () => {

		for ( let index = 0; index < 7; index ++ ) renderer.compute( { index, parameters: {} } );

	}, 4 );
	assert.equal( maximum, 4 );
	assert.deepEqual( dispatched, [ 0, 1, 2, 3, 4, 5, 6 ] );

} );

test( 'shared mutable uniforms form a compile barrier', async () => {

	const { renderer } = fixture();
	const uniform = { value: 0 };
	const compiled = [];
	renderer.compileComputeAsync = async () => {

		const value = uniform.value;
		await new Promise( resolve => setTimeout( resolve, 5 ) );
		assert.equal( uniform.value, value );
		compiled.push( value );

	};

	await prepareComputeAction( renderer, () => {

		for ( let value = 1; value <= 3; value ++ ) {

			uniform.value = value;
			renderer.compute( { parameters: { uniform } } );

		}

	} );
	assert.deepEqual( compiled, [ 1, 2, 3 ] );

} );

test( 'refills free compile slots without waiting for the slowest pending shader', async () => {

	const { renderer } = fixture();
	const events = [];
	renderer.compileComputeAsync = async node => {

		events.push( `start-${ node.index }` );
		await new Promise( resolve => setTimeout( resolve, node.index === 0 ? 50 : 5 ) );
		events.push( `end-${ node.index }` );

	};

	await prepareComputeAction( renderer, () => {

		for ( let index = 0; index < 4; index ++ ) renderer.compute( { index, parameters: {} } );

	}, 2 );
	assert.ok( events.indexOf( 'start-2' ) < events.indexOf( 'end-0' ) );

} );
