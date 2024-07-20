import {
	AgXToneMapping,
	Box3,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGLPathTracer } from '../src/index.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { LoaderElement } from './utils/LoaderElement.js';
import { getScaledSettings } from './utils/getScaledSettings.js';
import { MaterialOrbSceneLoader } from './utils/MaterialOrbLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

const DB_URL = 'https://api.physicallybased.info/materials';
const CREDITS = 'Materials courtesy of "physicallybased.info"';

let pathTracer, renderer, controls, shellMaterial;
let camera, database, scene;
let loader, imgEl;

const params = {
	material: null,
	tiles: 2,
	bounces: 5,
	multipleImportanceSampling: true,
	renderScale: 1 / window.devicePixelRatio,
	...getScaledSettings(),
};

init();

async function init() {

	RectAreaLightUniformsLib.init();

	loader = new LoaderElement();
	loader.attach( document.body );

	imgEl = document.getElementById( 'materialImage' );

	// renderer
	renderer = new WebGLRenderer( { antialias: true } );
	renderer.toneMapping = AgXToneMapping;
	renderer.toneMappingExposure = 0.02;
	document.body.appendChild( renderer.domElement );

	// path tracer
	pathTracer = new WebGLPathTracer( renderer );
	pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
	pathTracer.tiles.set( params.tiles, params.tiles );
	pathTracer.textureSize.set( 2048, 2048 );
	pathTracer.filterGlossyFactor = 0.5;

	// scene
	scene = new Scene();

	// load assets
	const [ orb, dbJson ] = await Promise.all( [
		new MaterialOrbSceneLoader().loadAsync(),
		fetch( DB_URL ).then( res => res.json() ),
	] );

	// scene initialization
	scene.add( orb.scene );
	camera = orb.camera;
	shellMaterial = orb.material;

	scene.attach( camera );
	camera.removeFromParent();
	camera.updateMatrixWorld();

	const fwd = new Vector3( 0, 0, - 1 ).transformDirection( camera.matrixWorld ).normalize();
	controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => pathTracer.updateCamera() );
	controls.target.copy( camera.position ).addScaledVector( fwd, 25 );
	controls.update();

	// database set up
	database = {};
	dbJson.forEach( mat => database[ mat.name ] = mat );
	params.material = Object.keys( database )[ 0 ];

	// initialize scene
	pathTracer.setScene( scene, camera );
	loader.setPercentage( 1 );
	loader.setCredits( CREDITS );

	onParamsChange();
	onResize();
	window.addEventListener( 'resize', onResize );

	// gui
	const gui = new GUI();
	gui.add( params, 'material', Object.keys( database ) ).onChange( onParamsChange );

	const ptFolder = gui.addFolder( 'Path Tracing' );
	ptFolder.add( params, 'multipleImportanceSampling' ).onChange( onParamsChange );
	ptFolder.add( params, 'tiles', 1, 4, 1 ).onChange( value => {

		pathTracer.tiles.set( value, value );

	} );
	ptFolder.add( params, 'bounces', 1, 30, 1 ).onChange( onParamsChange );
	ptFolder.add( params, 'renderScale', 0.1, 1 ).onChange( onParamsChange );

	animate();

}

function onResize() {

	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setPixelRatio( window.devicePixelRatio );
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	pathTracer.updateCamera();

}

function applyMaterialInfo( info, material ) {

	material.color.set( 0xffffff );
	material.transmission = 0.0;
	material.attenuationDistance = Infinity;
	material.attenuationColor.set( 0xffffff );
	material.specularColor.set( 0xffffff );
	material.metalness = 0.0;
	material.roughness = 1.0;
	material.ior = 1.5;
	material.thickness = 1.0;
	material.iridescence = 0.0;
	material.iridescenceIOR = 1.0;
	material.iridescenceThicknessRange = [ 0, 0 ];

	if ( info.specularColor ) material.specularColor.setRGB( ...info.specularColor );
	if ( 'metalness' in info ) material.metalness = info.metalness;
	if ( 'roughness' in info ) material.roughness = info.roughness;
	if ( 'ior' in info ) material.ior = info.ior;
	if ( 'transmission' in info ) material.transmission = info.transmission;
	if ( 'thinFilmThickness' in info ) {

		material.iridescence = 1.0;
		material.iridescenceIOR = info.thinFilmIor;
		material.iridescenceThicknessRange = [ info.thinFilmThickness, info.thinFilmThickness ];

	}

	if ( material.transmission ) {

		if ( info.color ) material.attenuationColor.setRGB( ...info.color );
		material.attenuationDistance = 1000 / info.density;

	} else {

		if ( info.color ) material.color.setRGB( ...info.color );

	}

	imgEl.src = info.reference[ 0 ];

}

function onParamsChange() {

	applyMaterialInfo( database[ params.material ], shellMaterial );

	pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
	pathTracer.renderScale = params.renderScale;
	pathTracer.bounces = params.bounces;
	pathTracer.updateMaterials();

}

function animate() {

	requestAnimationFrame( animate );
	pathTracer.renderSample();
	// renderer.render( scene, camera );
	loader.setSamples( pathTracer.samples, pathTracer.isCompiling );

}
