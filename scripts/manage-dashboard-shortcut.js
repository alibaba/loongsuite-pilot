// Run with /usr/bin/osascript -l JavaScript. No third-party modules or compilation.
// Keep the policy separate from the native adapter so tests never edit the real Dock.
const SHORTCUT_NAME = 'LoongSuite Pilot Dashboard.webloc';
const SHORTCUT_OWNER = 'loongsuite-pilot-dashboard-shortcut-v1';

function fail(message) { throw new Error(message); }

function manageShortcut(request, system) {
  const action = request.action;
  if (!['install', 'status', 'uninstall'].includes(action)) fail('Unknown shortcut action.');
  if (system.userName === 'root') fail('Run as the logged-in Mac user, without sudo.');
  if (typeof request.configPath !== 'string' || request.configPath[0] !== '/') fail('Expected an absolute configuration path.');
  if (action !== 'status' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.operationId || '')) fail('Expected a shortcut operation identifier.');
  if (action === 'install' && (!/^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(request.url || '')
    || Number(request.url.split(':')[2].slice(0, -1)) < 1
    || Number(request.url.split(':')[2].slice(0, -1)) > 65535)) fail('Expected a local Dashboard URL.');

  const base = system.homePath + '/Library/Application Support/LoongSuite Pilot/Shortcuts';
  const shortcutPath = base + '/' + SHORTCUT_NAME;
  function inspect() {
    system.checkParents(base);
    const file = system.readShortcut(shortcutPath);
    const managed = file.kind === 'file' && file.value
      && file.value.LoongSuitePilotManagedShortcut === SHORTCUT_OWNER
      && file.value.PilotConfigPath === request.configPath;
    const dock = system.readDock();
    const matches = dock.paths.filter(path => path === shortcutPath).length;
    return { file, managed: Boolean(managed), dock, matches };
  }
  const initial = inspect();
  const result = {
    action, shortcutPath, exists: initial.file.kind !== 'absent', managed: initial.managed,
    url: initial.managed ? initial.file.value.URL : null,
    dockMatches: initial.matches, dockLocked: initial.dock.locked,
    changed: false, iconApplied: false, dockChanged: false, backupPath: null, warnings: [],
  };
  if (action === 'status') return result;
  if (initial.file.kind !== 'absent' && !initial.managed) {
    fail('A shortcut at this path is unmanaged or belongs to another configuration. It was not changed: ' + shortcutPath);
  }
  if (action === 'uninstall' && initial.file.kind === 'absent' && initial.matches === 0) return result;
  // A missing file no longer carries proof of ownership. Never remove an orphaned
  // Dock item automatically; status reports it so the user can remove it manually.
  if (action === 'uninstall' && !initial.managed) fail('The shortcut file is missing. Remove its orphaned Dock entry manually.');

  return system.withLock(base, request.operationId, function () {
    const current = inspect();
    if (current.file.kind !== 'absent' && !current.managed) fail('Shortcut ownership changed. No changes made.');
    if (current.matches > 1) fail('Multiple matching Dock entries exist. Remove duplicates manually before retrying.');
    if (current.dock.locked) fail('The Dock is locked or managed. No changes made.');
    if (action === 'uninstall' && !current.managed) fail('Shortcut ownership changed. No changes made.');

    if (action === 'install') {
      const value = { URL: request.url, LoongSuitePilotManagedShortcut: SHORTCUT_OWNER,
        PilotConfigPath: request.configPath, PilotIconVersion: request.iconVersion };
      result.changed = !current.managed || Object.keys(value).some(key => current.file.value[key] !== value[key]);
      // Validate the asset before replacing an existing shortcut.
      system.validateIcon(request.iconPath);
      if (result.changed) system.writeShortcut(shortcutPath, value);
      result.iconApplied = system.setIcon(shortcutPath, request.iconPath);
      if (!result.iconApplied) {
        // Do not mark a failed icon as current; the next install must refresh it.
        system.writeShortcut(shortcutPath, Object.assign({}, value, { PilotIconVersion: '' }));
        result.warnings.push('The shortcut is usable, but macOS could not apply its custom icon. Run install again to retry.');
      }
      if (current.matches === 0) {
        result.backupPath = system.changeDock(current.dock, 'add', shortcutPath, base);
        result.dockChanged = true;
      }
      result.exists = true;
      result.managed = true;
      result.url = request.url;
      result.dockMatches = 1;
    } else {
      if (current.matches !== 0) {
        result.backupPath = system.changeDock(current.dock, 'remove', shortcutPath, base);
        result.dockChanged = true;
      }
      // Trash only the exact, owned regular file; keep backups and other files.
      system.trashShortcut(shortcutPath);
      result.exists = false;
      result.managed = false;
      result.url = null;
      result.dockMatches = 0;
      result.changed = true;
    }
    if (result.changed || result.dockChanged) {
      if (!system.refreshDock()) result.warnings.push('Dock settings were saved. Log out and back in if the icon has not refreshed.');
    }
    return result;
  });
}

function createMacSystem(domain, hooks) {
  ObjC.import('Foundation');
  ObjC.import('AppKit');
  domain = domain || 'com.apple.dock';
  hooks = hooks || {};
  const fm = $.NSFileManager.defaultManager;
  const unwrap = value => ObjC.unwrap(value);
  // Objective-C nil is a truthy bridge object in JXA; inspect its unwrapped value.
  const present = value => value != null && unwrap(value) != null;
  const get = (value, key) => value.objectForKey(key);
  const dict = value => present(value) && Boolean(value.isKindOfClass($.NSDictionary));
  const array = value => present(value) && Boolean(value.isKindOfClass($.NSArray));
  function xml(value) {
    const data = $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError(value, $.NSPropertyListXMLFormat_v1_0, 0, null);
    if (!present(data)) fail('Cannot encode a property list.');
    return data;
  }
  function xmlString(value) { return unwrap($.NSString.alloc.initWithDataEncoding(xml(value), $.NSUTF8StringEncoding)); }
  function plist(data) {
    if (!present(data)) fail('Cannot read a property list.');
    const value = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
    if (!dict(value)) fail('Unexpected property list format.');
    return value;
  }
  function command(path, args) {
    const task = $.NSTask.alloc.init;
    const pipe = $.NSPipe.pipe;
    task.launchPath = path;
    task.arguments = $(args);
    task.standardOutput = pipe;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    task.launch;
    const output = pipe.fileHandleForReading.readDataToEndOfFile;
    task.waitUntilExit;
    if (Number(task.terminationStatus) !== 0) fail('macOS command failed: ' + path);
    return output;
  }
  function kind(path) {
    const attrs = fm.attributesOfItemAtPathError(path, null);
    if (!present(attrs)) {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      if (fm.fileExistsAtPath(parent) && !fm.isReadableFileAtPath(parent)) fail('Cannot inspect path permissions: ' + parent);
      return 'absent';
    }
    const type = unwrap(get(attrs, 'NSFileType'));
    return type === 'NSFileTypeRegular' ? 'file' : type === 'NSFileTypeDirectory' ? 'directory' : 'other';
  }
  function checkParents(path) {
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current += '/' + part;
      const type = kind(current);
      if (type !== 'absent' && type !== 'directory') fail('Refusing a non-directory or symbolic-link parent: ' + current);
    }
  }
  function directory(path) {
    checkParents(path);
    if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $({ NSFilePosixPermissions: 448 }), null)) fail('Cannot create the shortcut directory.');
  }
  function write(path, data) {
    if (!data.writeToFileAtomically(path, true)) fail('Cannot write: ' + path);
    if (!fm.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 384 }), path, null)) fail('Cannot secure file permissions: ' + path);
  }
  function dockFilePath(item) {
    if (!dict(item)) fail('Unexpected Dock entry format.');
    const tile = get(item, 'tile-data');
    const file = dict(tile) ? get(tile, 'file-data') : null;
    if (!dict(file)) return null;
    const raw = unwrap(get(file, '_CFURLString'));
    if (typeof raw !== 'string') return null;
    return raw.startsWith('file:') ? unwrap($.NSURL.URLWithString(raw).path) : raw;
  }
  function readDock() {
    const native = plist(command('/usr/bin/defaults', ['export', domain, '-']));
    const apps = get(native, 'persistent-apps');
    const others = get(native, 'persistent-others');
    if (!array(apps) || !array(others)) fail('Unexpected Dock arrays. No settings changed.');
    const paths = [];
    for (let i = 0; i < Number(others.count); i++) paths.push(dockFilePath(others.objectAtIndex(i)));
    const immutable = unwrap(get(native, 'contents-immutable'));
    const prefs = $.NSUserDefaults.standardUserDefaults;
    const locked = immutable === true || immutable === 1
      || Boolean(prefs.objectIsForcedForKeyInDomain('persistent-others', domain))
      || Boolean(prefs.objectIsForcedForKeyInDomain('contents-immutable', domain));
    return { native, apps, others, paths, locked };
  }
  function changeDock(before, action, shortcutPath, base) {
    const backupDir = base + '/Backups';
    directory(backupDir);
    const backupPath = backupDir + '/dock-' + unwrap($.NSUUID.UUID.UUIDString) + '.plist';
    write(backupPath, xml(before.native));
    const expected = $.NSMutableArray.alloc.init;
    for (let i = 0; i < Number(before.others.count); i++) {
      const item = before.others.objectAtIndex(i);
      if (action !== 'remove' || dockFilePath(item) !== shortcutPath) expected.addObject(item);
    }
    let newItem;
    if (action === 'add') {
      newItem = $({ 'tile-type': 'file-tile', 'tile-data': { 'file-label': 'LoongSuite Pilot Dashboard',
        'file-data': { _CFURLString: unwrap($.NSURL.fileURLWithPath(shortcutPath).absoluteString), _CFURLStringType: 15 } } });
      expected.addObject(newItem);
    }
    const latest = readDock();
    if (latest.locked || !latest.others.isEqual(before.others) || !latest.apps.isEqual(before.apps)) fail('The Dock changed concurrently. Retry the command.');
    function writeDockArray(items) {
      const args = ['write', domain, 'persistent-others', '-array'];
      for (let i = 0; i < Number(items.count); i++) args.push(xmlString(items.objectAtIndex(i)));
      command('/usr/bin/defaults', args);
    }
    // Preserve NSData/bookmarks by serializing native plist objects, never JSON.
    if (action === 'add') command('/usr/bin/defaults', ['write', domain, 'persistent-others', '-array-add', xmlString(newItem)]);
    else writeDockArray(expected);
    if (typeof hooks.afterDockWrite === 'function') hooks.afterDockWrite(command, domain, xmlString);
    const after = readDock();
    const targetCount = after.paths.filter(path => path === shortcutPath).length;
    const expectedTargetCount = action === 'add' ? 1 : 0;
    const expectedCount = Number(expected.count);
    let unchangedEntries = Number(after.others.count) === expectedCount;
    for (let i = 0; unchangedEntries && i < expectedCount; i++) {
      // macOS may enrich the new target tile with GUID/bookmark fields.
      if (action === 'add' && i === expectedCount - 1) continue;
      unchangedEntries = Boolean(after.others.objectAtIndex(i).isEqual(expected.objectAtIndex(i)));
    }
    if (targetCount !== expectedTargetCount || !unchangedEntries) {
      const rollbackBase = readDock();
      if (!rollbackBase.apps.isEqual(after.apps) || !rollbackBase.others.isEqual(after.others)) {
        fail('Dock verification failed and the Dock changed again; no automatic rollback was attempted. Inspect the backup: ' + backupPath);
      }
      try {
        writeDockArray(before.others);
        const restored = readDock();
        if (!restored.others.isEqual(before.others)) throw new Error('rollback verification failed');
      } catch (_) {
        fail('Dock verification failed and the previous files-area layout could not be restored. Inspect the backup: ' + backupPath);
      }
      fail('Dock verification failed; the previous files-area layout was restored. Retry the command. Backup: ' + backupPath);
    }
    return backupPath;
  }
  return {
    homePath: unwrap($.NSHomeDirectory()), userName: unwrap($.NSUserName()),
    checkParents, readDock, changeDock,
    readShortcut(path) {
      const type = kind(path);
      if (type !== 'file') return { kind: type };
      try { return { kind: type, value: ObjC.deepUnwrap(plist($.NSData.dataWithContentsOfFile(path))) }; }
      catch (_) { return { kind: type, value: null }; }
    },
    withLock(base, owner, fn) {
      directory(base);
      const lock = base + '/Operation.lock';
      if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(lock, false, $({ NSFilePosixPermissions: 448 }), null)) {
        fail('Another shortcut command may be running. If none is running, inspect the operation lock: ' + lock);
      }
      try {
        write(lock + '/Owner', $(owner).dataUsingEncoding($.NSUTF8StringEncoding));
        return fn();
      } finally { fm.removeItemAtPathError(lock, null); }
    },
    validateIcon(path) {
      if (typeof path !== 'string' || !present($.NSImage.alloc.initWithContentsOfFile(path))) fail('The bundled shortcut icon is missing or invalid. Repair the Pilot installation.');
    },
    writeShortcut(path, value) { write(path, xml($(value))); },
    setIcon(path, iconPath) {
      return Boolean($.NSWorkspace.sharedWorkspace.setIconForFileOptions($.NSImage.alloc.initWithContentsOfFile(iconPath), path, 0));
    },
    trashShortcut(path) {
      if (!fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, null)) fail('Cannot move the shortcut to Trash: ' + path);
    },
    refreshDock() {
      try { command('/usr/bin/killall', ['-u', unwrap($.NSUserName()), 'Dock']); return true; }
      catch (_) { return false; }
    },
  };
}

function run(argv) {
  try {
    if (argv.length !== 1) fail('Expected one shortcut request from the Pilot CLI.');
    return JSON.stringify({ ok: true, result: manageShortcut(JSON.parse(argv[0]), createMacSystem()) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error.message || 'Shortcut operation failed.') });
  }
}
