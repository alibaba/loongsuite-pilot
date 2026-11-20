// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { applyEdits, createScanner, findNodeAtLocation, parseTree, SyntaxKind, type ParseError } from 'jsonc-parser';
import { readCopilotFile, writeCopilotFile } from './copilot-config-file.js';

/** Validate both files before editing; remove only Pilot-owned JSONC paths. */
export async function removeCopilotRegistrations(settingsPath: string, configPath: string, pluginId: string): Promise<void> {
  const files = await Promise.all([settingsPath, configPath].map(readCopilotFile));
  const edits = files.map((snapshot, index) => {
    if (!snapshot.exists) return snapshot.content;
    const errors: ParseError[] = [];
    const bom = snapshot.content.startsWith('\uFEFF') ? '\uFEFF' : '';
    let text = snapshot.content.slice(bom.length);
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || tree?.type !== 'object') throw new Error('Invalid Copilot JSONC; original file preserved');
    // jsonc.modify removes adjacent comments when deleting a property/element.
    // Delete only the owned AST node and its separator, preserving all trivia.
    const remove = (key: (string | number)[]) => {
      const value = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true })!, key)!;
      const node = typeof key.at(-1) === 'string' ? value.parent! : value;
      const siblings = node.parent!.children!;
      const position = siblings.indexOf(node);
      const scanner = createScanner(text, true);
      scanner.setPosition(node.offset + node.length);
      const changes = [{ offset: node.offset, length: node.length, content: '' }];
      if (scanner.scan() === SyntaxKind.CommaToken) {
        changes.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
      } else if (position > 0) {
        const previous = siblings[position - 1];
        scanner.setPosition(previous.offset + previous.length);
        if (scanner.scan() !== SyntaxKind.CommaToken) throw new Error('Missing JSONC separator');
        changes.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
      }
      text = applyEdits(text, changes);
    };
    const enabled = findNodeAtLocation(tree, ['enabledPlugins']);
    if (index === 0 && enabled) {
      if (enabled.type !== 'object') throw new Error('Invalid Copilot enabledPlugins map');
      const key = `${pluginId}@${pluginId}`;
      if (findNodeAtLocation(tree, ['enabledPlugins', key])) remove(['enabledPlugins', key]);
    }
    const installed = findNodeAtLocation(tree, ['installedPlugins']);
    if (index === 1 && installed) {
      if (installed.type !== 'array') throw new Error('Invalid Copilot installedPlugins array');
      for (let i = (installed.children?.length ?? 0) - 1; i >= 0; i--) {
        if (findNodeAtLocation(tree, ['installedPlugins', i, 'name'])?.value === pluginId
          && findNodeAtLocation(tree, ['installedPlugins', i, 'marketplace'])?.value === pluginId) remove(['installedPlugins', i]);
      }
    }
    const remainingErrors: ParseError[] = [];
    parseTree(text, remainingErrors, { allowTrailingComma: true });
    if (remainingErrors.length) throw new Error('Invalid JSONC cleanup result; original file preserved');
    return bom + text;
  });
  for (let i = 0; i < files.length; i++) {
    if (files[i].exists) await writeCopilotFile(files[i], edits[i]);
  }
}
