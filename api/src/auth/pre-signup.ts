// Declencheur Cognito PreSignUp (design-v2 4.7): l'inscription d'un parent exige un code d'invitation a usage unique.
// Le code est genere par Alexis (scripts/create-invite.ts), seul son hache SHA-256 est stocke (INVITE#<hache>).
import { createHash } from 'node:crypto';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { PreSignUpTriggerEvent } from 'aws-lambda';

const ddb = new DynamoDBClient({});
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Consume = (table: string, hash: string) => Promise<boolean>;

/** Marque l'invitation utilisee, de facon conditionnelle (existe ET pas encore utilisee). */
const consumeInvite: Consume = async (table, hash) => {
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { PK: { S: `INVITE#${hash}` }, SK: { S: 'META' } },
        UpdateExpression: 'SET utilisee = :t, utiliseeLe = :d',
        ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(utilisee) OR utilisee = :f)',
        ExpressionAttributeValues: { ':t': { BOOL: true }, ':f': { BOOL: false }, ':d': { S: new Date().toISOString() } },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
};

export async function checkInvite(event: PreSignUpTriggerEvent, table: string, consume: Consume): Promise<PreSignUpTriggerEvent> {
  // Les eleves sont crees par le serveur (AdminCreateUser): pas d'invitation, le parent a deja ete verifie.
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  // Inscription libre: invitation obligatoire. Les connexions federees ne sont pas prevues.
  if (event.triggerSource !== 'PreSignUp_SignUp') throw new Error('inscription_refusee');
  const code = event.request.clientMetadata?.inviteCode;
  if (typeof code !== 'string' || code.length < 16 || code.length > 128) throw new Error('invitation_invalide');
  if (!(await consume(table, sha256(code)))) throw new Error('invitation_invalide');
  return event;
}

export const handler = (event: PreSignUpTriggerEvent) => {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME manquant');
  return checkInvite(event, table, consumeInvite);
};
