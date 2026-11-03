# QwenWorkCN wrapper compatibility diagnostics

The original diagnostics declaration in
tests/unit/hooks/qwen-work-cn-wrapper-path.test.mjs still protects the
packaged qoderwork-runtime-wrapper.mjs: an already running host application
can retain an old override, and the compatibility wrapper logs beside its
installed location while forwarding only to that application's own runtime.

Run this optional host contract with a development Node installation:

    npm test -- tests/unit/hooks/qwen-work-cn-wrapper-path.test.mjs --cache=false --testNamePattern='derives diagnostics output from the runtime wrapper location'

This selection executes one unchanged declaration. The other four declarations
are handled separately: native shell/PowerShell installed-path tests replace
data-directory transport; core Node resolver alignment is retired with the
Node collector bootstrap. Those old Node-specific assertions are neither run
nor counted as native passes.

The native core package includes shared/native.sh and shared/native.ps1.
The old shared/node-runtime.sh and shared/common.ps1 selectors are absent
from every supported package resource set and have no current Hook callers.
Third-party host token/preload and retired-override forwarding assets remain
packaged and tested. No Node collector, managed Node installation, or Node
version-selection fallback is restored.
