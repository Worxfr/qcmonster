// Types issus du contrat (generes par le lot 1). On ne les redefinit pas a la main.
import type { components } from '../../shared/contract/generated/types';

type S = components['schemas'];
export type Me = S['Me'];
export type Progress = S['Progress'];
export type Job = S['Job'];
export type JobState = S['JobState'];
export type Transcription = S['Transcription'];
export type Doc = S['DocSummary'] & { summary: string; claims: S['Claim'][] };
export type DocSummary = S['DocSummary'];
export type Claim = S['Claim'];
export type Source = S['Source'];
export type Question = S['Question'];
export type Session = S['Session'];
export type AnswerResult = S['AnswerResult'];
export type Student = S['Student'];
export type StudentCreateRequest = S['StudentCreateRequest'];
export type StudentCreateResponse = S['StudentCreateResponse'];
export type Dashboard = S['Dashboard'];
export type Leaderboard = S['Leaderboard'];
export type ScanCreateResponse = S['ScanCreateResponse'];
export type Sentence = S['Sentence'];
export type ReadResult = S['ReadResult'];
