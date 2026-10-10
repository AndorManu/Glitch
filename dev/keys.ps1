param([string]$Chord = "ctrl+alt+shift+g")
# Presses one key chord for real (keybd_event), e.g. "ctrl+alt+shift+g".
# Only used by dev/panic-check.mjs, after it has confirmed that the test copy
# of Glitch owns the shortcut (otherwise the keys would reach whatever window
# has the focus).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$map = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; win = 0x5B }
$keys = @()
foreach ($part in $Chord.ToLower().Split('+')) {
  if ($map.ContainsKey($part)) { $keys += $map[$part] }
  elseif ($part.Length -eq 1) { $keys += [int][char]$part.ToUpper() }
  else { throw "unknown key $part" }
}
foreach ($k in $keys) { [K]::keybd_event([byte]$k, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25 }
Start-Sleep -Milliseconds 80
[array]::Reverse($keys)
foreach ($k in $keys) { [K]::keybd_event([byte]$k, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25 }
