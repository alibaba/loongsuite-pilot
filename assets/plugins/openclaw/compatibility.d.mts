export const MIN_OPENCLAW_VERSION: string;
export interface OpenClawCapabilities {
  version: string;
  adapter: 'modern' | 'legacy';
  conversationAccess: boolean;
}
export function openClawCapabilities(version: unknown): OpenClawCapabilities | null;
