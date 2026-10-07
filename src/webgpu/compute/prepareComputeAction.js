const owners = new WeakSet();

function snapshot( value ) {

	return value && ( value.isVector2 || value.isVector3 || value.isVector4 || value.isMatrix3 || value.isMatrix4 || value.isColor || value.isQuaternion ) ? value.clone() : value;

}

/**
 * Records setup dispatches, prepares their pipelines, and replays resource changes in order.
 * The action must be synchronous; callers must suspend rendering on this renderer until it resolves.
 * @param {Object} renderer
 * @param {Function} action
 * @param {number} concurrency
 * @returns {Promise<*>}
 */
export async function prepareComputeAction( renderer, action, concurrency = 4 ) {

	if ( ! renderer.compileComputeAsync ) throw new Error( 'Async preparation requires three.js r186 or newer.' );
	if ( owners.has( renderer ) ) throw new Error( 'Compute preparation is already active on this renderer.' );
	if ( ! Number.isInteger( concurrency ) || concurrency < 1 || concurrency > 8 ) throw new Error( 'Compile concurrency must be between 1 and 8.' );
	owners.add( renderer );
	const compute = renderer.compute;
	const copy = renderer.copyTextureToTexture;
	const commands = [];
	const touched = new Set();
	const disposals = new Map();
	const protect = value => {

		if ( ! value || typeof value.dispose !== 'function' || disposals.has( value ) ) return;
		const dispose = value.dispose;
		disposals.set( value, dispose );
		value.dispose = ( ...args ) => commands.push( { disposal: true, run: () => dispose.apply( value, args ) } );

	};

	const assign = values => {

		for ( const [ uniform, value ] of values || [] ) uniform.value = snapshot( value );

	};

	let finalValues;
	try {

		await renderer.init();
		renderer.compute = ( ...args ) => {

			const nodes = Array.isArray( args[ 0 ] ) ? [ ...args[ 0 ] ] : [ args[ 0 ] ];
			nodes.forEach( protect );
			const values = nodes.flatMap( node => Object.values( node.parameters || node.computeNode?.parameters || {} ).filter( uniform => uniform && typeof uniform === 'object' && 'value' in uniform ).map( uniform => {

				touched.add( uniform );
				protect( uniform.value );
				return [ uniform, snapshot( uniform.value ) ];

			} ) );
			const dispatch = Array.isArray( args[ 1 ] ) ? [ ...args[ 1 ] ] : args[ 1 ];
			commands.push( { nodes, values, run: () => compute.call( renderer, Array.isArray( args[ 0 ] ) ? nodes : nodes[ 0 ], dispatch ) } );

		};

		renderer.copyTextureToTexture = ( ...args ) => {

			args.forEach( protect );
			commands.push( { run: () => copy.apply( renderer, args ) } );

		};

		let result;
		try {

			result = action();
			if ( result && typeof result.then === 'function' ) throw new Error( 'Compute preparation requires a synchronous action.' );

		} finally {

			renderer.compute = compute;
			renderer.copyTextureToTexture = copy;
			for ( const [ resource, dispose ] of disposals ) resource.dispose = dispose;
			finalValues = [ ...touched ].map( uniform => [ uniform, snapshot( uniform.value ) ] );

		}

		// Only independent nodes may compile together. Shared mutable uniforms form a barrier.
		const seen = new Set();
		const pending = new Set();
		const promises = [];
		const failures = [];
		try {

			for ( const command of commands ) {

				for ( const node of command.nodes || [] ) {

					if ( seen.has( node ) ) continue;
					const uniforms = new Set( command.values.map( ( [ uniform ] ) => uniform ) );
					const conflicts = [ ...pending ].filter( task => [ ...uniforms ].some( uniform => task.uniforms.has( uniform ) ) );
					await Promise.all( conflicts.map( task => task.promise ) );
					if ( pending.size >= concurrency ) await Promise.race( [ ...pending ].map( task => task.promise ) );
					if ( failures.length ) throw failures[ 0 ];
					assign( command.values );
					seen.add( node );
					const task = { uniforms };
					task.promise = Promise.resolve().then( () => renderer.compileComputeAsync( node ) ).then( () => {

						pending.delete( task );

					}, error => {

						failures.push( error );
						pending.delete( task );

					} );
					pending.add( task );
					promises.push( task.promise );

				}

			}

		} finally {

			// Do not dispose recorded resources while another compiler still uses them.
			await Promise.all( promises );

		}

		if ( failures.length ) throw failures[ 0 ];
		for ( const command of commands ) {

			assign( command.values );
			command.done = true;
			command.run();

		}

		return result;

	} finally {

		renderer.compute = compute;
		renderer.copyTextureToTexture = copy;
		for ( const [ resource, dispose ] of disposals ) resource.dispose = dispose;
		assign( finalValues );
		for ( const command of commands ) {

			if ( command.disposal && ! command.done ) {

				command.done = true;
				command.run();

			}

		}

		owners.delete( renderer );

	}

}
