// DEMO, do not merge: runtime cycle
import { a } from './demoCycleA';
export const b = (): number => (a.length ? 0 : 1);
