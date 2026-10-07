import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

export function browserExecutable( explicit ) {

	if ( explicit ) {

		if ( ! existsSync( explicit ) ) throw new Error( `Browser does not exist: ${ explicit }` );
		return explicit;

	}

	const candidates = [
		join( process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe' ),
		join( process.env[ 'PROGRAMFILES(X86)' ] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe' ),
		join( process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'Google/Chrome/Application/chrome.exe' ),
		puppeteer.executablePath(),
	];
	const executable = candidates.find( candidate => existsSync( candidate ) );
	if ( ! executable ) throw new Error( 'Browser not found. Pass --browser or set CHROME_PATH.' );
	return executable;

}

export async function removeProfile( profile ) {

	const absolute = resolve( profile );
	if ( dirname( absolute ) !== resolve( tmpdir() ) || ! basename( absolute ).startsWith( 'pathtracer-' ) ) {

		throw new Error( `Refusing to remove a profile outside the benchmark temp directory: ${ absolute }` );

	}

	await rm( absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 } );

}
