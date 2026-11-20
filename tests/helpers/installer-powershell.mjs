export function readInstallerWriteConfig(source) {
  // Start at the function declaration and look for its closing brace after the embedded Node program.
  const writer = source.match(/^function Write-Config \{[\s\S]*?^'@ \$cfgTmp\r?\n[\s\S]*?^\}\r?$/m)?.[0];
  if (!writer) throw new Error('Could not locate the PowerShell installer Write-Config function');
  return writer;
}

// The fixture runs the parser and config writer with TEMP set to its own temporary directory.
export const installerWriteConfigStubs = `
function Msg { }
function Remove-PilotPathQuietly { param([string]$Path) Remove-Item -LiteralPath $Path -Force }
`;
