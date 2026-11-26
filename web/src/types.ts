// Types issus du contrat (generes par le lot 1). On ne les redefinit pas a la main.
import type { components } from '../../shared/contract/generated/types';

type S = components['schemas'];
export type Me = S['Me'];
export type Progress = S['Progress'];
export type Job = S['Job'];
export type JobState = S['JobState'];
export type Transcription = S['Transcription'];
export type Doc = S['Doc'];
export type DocSummary = S['DocSummary'];
export type Claim = S['Claim'];
export type Source = S['Source'];
export type Question = S['Question'];
export type Session = S['Session'];
export type PracticeSession = S['PracticeSession'];
export type PracticeRequest = S['PracticeRequest'];
export type AnswerResult = S['AnswerResult'];
export type Student = S['Student'];
export type ActivationResponse = S['ActivationResponse'];
export type StudentCreateRequest = S['StudentCreateRequest'];
export type InvitationCreated = S['InvitationCreated'];
export type FamilyCreateRequest = S['FamilyCreateRequest'];
export type StudentCreateResponse = S['StudentCreateResponse'];
export type Dashboard = S['Dashboard'];
export type Leaderboard = S['Leaderboard'];
export type ScanCreateResponse = S['ScanCreateResponse'];
export type Sentence = S['Sentence'];
export type ReadResult = S['ReadResult'];
export type ScanList = S['ScanList'];
export type ScanSummary = S['ScanSummary'];
export type ScanStatus = S['ScanStatus'];
export type Cours = S['Cours'];
export type Folder = S['Folder'];
export type ConfirmSection = S['ConfirmSection'];
export type SuggestedSection = S['SuggestedSection'];
export type Subject = S['Subject'];
export type ScanQuery = {
  studentId?: string; subject?: Subject | 'none'; topic?: string; folderId?: string;
  status?: 'en_cours' | 'a_confirmer' | 'termine' | 'echec'; sort?: 'date' | 'subject' | 'topic' | 'status'; order?: 'asc' | 'desc';
  limit?: number; cursor?: string;
};
export type ScanStage = S['ScanStage'];
// H1 (contrat 1.4): historique des tests, vue parent, archive.
export type TestSummary = S['TestSummary'];
export type TestPage = S['TestPage'];
export type TestDetail = S['TestDetail'];
export type TestParentDetail = S['TestParentDetail'];
export type TestQuestionResult = S['TestQuestionResult'];
export type TestQuestionStatus = S['TestQuestionStatus'];
export type StudentProgressView = S['StudentProgressView'];
export type ExportArchive = S['ExportArchive'];
export type TestQuery = { schoolYear?: string; limit?: number; cursor?: string };
// R1 (contrat 1.5): blocs, figures, marques de verification, fiche en paragraphes.
export type Block = S['Block'];
export type Figure = S['Figure'];
export type FigureBox = S['FigureBox'];
export type ConfirmFigure = S['ConfirmFigure'];
export type SentenceMark = S['SentenceMark'];
export type FicheParagraph = S['FicheParagraph'];
export type RecallItem = S['RecallItem'];
/** Export asynchrone de l'eleve (contrat 1.5.1): `state` en_cours | pret (avec `archive`) | echec. */
export type ExportState = S['ExportStatus'];
// E1 (contrat 1.9): exercices de raisonnement et correction de la copie photographiee.
export type Exercice = S['Exercice'];
export type ExerciceResume = S['ExerciceResume'];
export type ExerciceCreated = S['ExerciceCreated'];
export type ExerciceHint = S['ExerciceHint'];
export type ExerciceSolution = S['ExerciceSolution'];
export type CopieCreateResponse = S['CopieCreateResponse'];
export type CopieEnvoi = S['CopieEnvoi'];
export type CopieSubmitResponse = S['CopieSubmitResponse'];
export type Copie = S['Copie'];
export type CopieEtape = S['CopieEtape'];
