// Authorization boundary between interaction channels and operations
// (lib/actions/action_policy.dart):
// * ui/system may run everything (consequential actions still need a reviewed confirmation);
// * agent/voice must confirm every action and may never delete records;
// * import may only create.

import { AppFailure } from '../core/failure';
import type { ActionDescriptor, Channel } from './types';

export function checkPolicy(action: ActionDescriptor, channel: Channel): void {
  const isDelete = action.id.endsWith('.delete');
  if ((channel === 'agent' || channel === 'voice') && isDelete) {
    throw AppFailure.notPermitted('Deleting records is only possible from within the app.');
  }
  if (channel === 'import' && !action.id.endsWith('.create')) {
    throw AppFailure.notPermitted('Imports can only create new records.');
  }
}

export function channelRequiresConfirmation(channel: Channel): boolean {
  return channel === 'agent' || channel === 'voice';
}

/** Channels a client may claim over HTTP (`system` is server-internal). */
export const CLIENT_CHANNELS = ['ui', 'agent', 'voice', 'import'] as const;
