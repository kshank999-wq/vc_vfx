import { randomBytes } from 'node:crypto';
import { serialFromBytes } from '@vcvfx/domain';

/**
 * `VFX-XXXXX-XXXXX-XXXXX-XXXXX`. The serial identifies a licence row; it is
 * not a secret and carries no entitlement — activation always checks the
 * database and the signed-in account.
 */
export const generateSerial = (): string => serialFromBytes(randomBytes(20));
