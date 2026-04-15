import { nanoid } from 'nanoid';

type Prefix = 'msg' | 'req' | 'toolu' | 'tool' | 'preset';

export function generateId(prefix: Prefix, length = 24): string {
  return `${prefix}_${nanoid(length)}`;
}
