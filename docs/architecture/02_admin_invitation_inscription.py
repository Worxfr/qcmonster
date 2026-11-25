from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import Client, User, Users
from diagrams.aws.network import APIGateway
from diagrams.aws.security import Cognito
from diagrams.onprem.vcs import Github

from common import aws_account, diagram, plain, region, step

with diagram("02_admin_invitation_inscription", "Parcours 2: code d'invitation (admin) puis inscription du parent") as _:
    admin = User("Administrateur\n(groupe admin)")
    parent = Users("Futur parent")
    mail = Client("Boîte e-mail\ndu parent")
    gh = Github("Repli: workflow « invite »\nou scripts/create-invite.ts")
    with aws_account():
        with region():
            cog = Cognito("Cognito\n(pool, client -signup\nsans connexion)")
            pre = Lambda("auth-presignup\n(déclencheur PreSignUp)")
            api = APIGateway("API Gateway HTTP\n(autorisateur JWT)")
            inv = Lambda("admin-invitations\n(POST /admin/invitations)")
            db = Dynamodb("DynamoDB\nINVITE#<hache SHA-256>\nINVITE#AUDIT#…")

    admin >> step(1, "POST /admin/invitations\n(jeton ID, groupe admin)") >> api
    api >> step(1) >> inv
    inv >> step(2, "audit (max 20/jour)\n+ code haché") >> db
    inv >> step(3, "code en clair,\naffiché une seule fois") >> admin
    admin >> plain("transmet le code\n(hors AWS)", style="dotted") >> parent
    parent >> step(4, "SignUp + code\n(inviteCode)") >> cog
    cog >> step(5, "appelle") >> pre
    pre >> step(6, "consomme le code\n(écriture conditionnelle)") >> db
    cog >> step(7, "e-mail avec un code\nà 6 chiffres") >> mail
    mail >> step(8, "ConfirmSignUp\n(code saisi)", style="dotted") >> cog
    gh >> plain("repli: rôle OIDC dédié,\nPutItem INVITE#* seulement") >> db
