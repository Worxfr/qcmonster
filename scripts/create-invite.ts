// Genere un code d'invitation parent a usage unique (design-v2 4.7). Seul le HACHE va dans DynamoDB.
// Par defaut: simulation (affiche le code et l'element, n'ecrit rien). --apply ecrit dans la table qcm-<env>.
// Lance par le proprietaire dans son terminal avec ses identifiants AWS: l'agent ne l'execute jamais avec --apply.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { inviteItem, newInviteCode } from '../shared/invite.js';
import { ENVS, REGION, tableName, type Env } from '../shared/names.js';

const args = process.argv.slice(2);
const env = (args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'dev') as Env;
if (!ENVS.includes(env)) throw new Error(`--env invalide: ${env}`);
const apply = args.includes('--apply');

const code = newInviteCode(); // 128 bits
const item = inviteItem(code);

console.log(`Code d'invitation (a transmettre au parent, non stocke en clair): ${code}`);
if (!apply) {
  console.log(`[simulation] ecrirait dans ${tableName(env)}:`, JSON.stringify(item));
} else {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  await ddb.send(new PutCommand({ TableName: tableName(env), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
  console.log(`ecrit dans ${tableName(env)}`);
}
