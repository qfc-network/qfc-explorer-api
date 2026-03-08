import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VyperCompileResult {
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
}

export interface VyperCompileError {
  error: string;
  details?: string;
}

function exec(cmd: string, args: string[], timeout = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Compile Vyper source code.
 * Tries local `vyper` binary first, then falls back to Docker.
 */
export async function compileVyper(
  source: string,
  version: string,
  evmVersion: string = 'paris',
): Promise<VyperCompileResult | VyperCompileError> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'vyper-'));
  const srcPath = join(tmpDir, 'contract.vy');

  try {
    await writeFile(srcPath, source, 'utf-8');

    // Try local vyper first
    try {
      return await compileLocal(srcPath, evmVersion);
    } catch {
      // Fall back to Docker
    }

    try {
      return await compileDocker(tmpDir, version, evmVersion);
    } catch (dockerErr) {
      return {
        error: 'Compilation failed',
        details: dockerErr instanceof Error ? dockerErr.message : String(dockerErr),
      };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function compileLocal(srcPath: string, evmVersion: string): Promise<VyperCompileResult> {
  // Get ABI
  const { stdout: abiOut } = await exec('vyper', ['-f', 'abi', '--evm-version', evmVersion, srcPath]);
  const abi = JSON.parse(abiOut.trim());

  // Get bytecode (creation bytecode)
  const { stdout: bytecodeOut } = await exec('vyper', ['-f', 'bytecode', '--evm-version', evmVersion, srcPath]);
  const bytecode = bytecodeOut.trim().replace(/^0x/, '');

  // Get deployed (runtime) bytecode
  const { stdout: runtimeOut } = await exec('vyper', ['-f', 'bytecode_runtime', '--evm-version', evmVersion, srcPath]);
  const deployedBytecode = runtimeOut.trim().replace(/^0x/, '');

  return { abi, bytecode, deployedBytecode };
}

async function compileDocker(tmpDir: string, version: string, evmVersion: string): Promise<VyperCompileResult> {
  const image = `ethereum/vyper:${version}`;

  // Get ABI
  const { stdout: abiOut } = await exec('docker', [
    'run', '--rm',
    '-v', `${tmpDir}:/code`,
    image,
    '-f', 'abi',
    '--evm-version', evmVersion,
    '/code/contract.vy',
  ], 120_000);
  const abi = JSON.parse(abiOut.trim());

  // Get bytecode
  const { stdout: bytecodeOut } = await exec('docker', [
    'run', '--rm',
    '-v', `${tmpDir}:/code`,
    image,
    '-f', 'bytecode',
    '--evm-version', evmVersion,
    '/code/contract.vy',
  ], 120_000);
  const bytecode = bytecodeOut.trim().replace(/^0x/, '');

  // Get deployed bytecode
  const { stdout: runtimeOut } = await exec('docker', [
    'run', '--rm',
    '-v', `${tmpDir}:/code`,
    image,
    '-f', 'bytecode_runtime',
    '--evm-version', evmVersion,
    '/code/contract.vy',
  ], 120_000);
  const deployedBytecode = runtimeOut.trim().replace(/^0x/, '');

  return { abi, bytecode, deployedBytecode };
}

/**
 * Strip Vyper metadata from bytecode.
 * Vyper appends a shorter metadata section than Solidity.
 * Vyper >=0.3.4 appends: <cbor_encoded_metadata><length_2bytes>
 * The last 2 bytes encode the length of the metadata in bytes.
 */
export function stripVyperMetadata(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 4) return clean;

  // Vyper metadata: last 2 bytes = length of metadata (including those 2 bytes)
  const metaLen = parseInt(clean.slice(-4), 16) * 2 + 4;
  if (metaLen > 0 && metaLen < clean.length) {
    return clean.slice(0, clean.length - metaLen);
  }

  return clean;
}
