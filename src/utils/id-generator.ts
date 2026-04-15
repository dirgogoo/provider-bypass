import { nanoid } from 'nanoid';

type Prefix = 'msg' | 'req' | 'toolu' | 'tool' | 'preset' | 'rs';

export function generateId(prefix: Prefix, length = 24): string {
  return `${prefix}_${nanoid(length)}`;
}
