import act1 from '../data/missions/act1.json';
import act2 from '../data/missions/act2.json';
import act3 from '../data/missions/act3.json';
import type { MissionDef } from './schema';

/** All story missions in order. */
export const MISSIONS: MissionDef[] = [...(act1 as MissionDef[]), ...(act2 as MissionDef[]), ...(act3 as MissionDef[])];
export const MISSION_BY_ID: Record<string, MissionDef> = Object.fromEntries(MISSIONS.map((m) => [m.id, m]));
