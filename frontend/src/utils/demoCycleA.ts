// DEMO, do not merge: runtime cycle
import { b } from './demoCycleB';
export const a = (): number => b() + 1;
