from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import User
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.security import Cognito

from common import aws_account, diagram, plain, region, step

with diagram("03_eleve_activation", "Parcours 3: ajout d'un élève par le parent et activation du compte") as _:
    parent = User("Parent")
    kid = User("Élève")
    with aws_account():
        with region():
            cdn = CloudFront("CloudFront + S3\n(page /activer)")
            api = APIGateway("API Gateway HTTP")
            create = Lambda("students-create\n(POST /students)")
            act = Lambda("activation-post\n(POST /activation,\nroute publique)")
            db = Dynamodb("DynamoDB\nSTUDENT#\nACTIVATION#")
            cog = Cognito("Cognito")

    parent >> step(1, "POST /students\n(pseudo, consentements)") >> api
    api >> step(1) >> create
    create >> step(2, "élève + jeton haché\n(24 h, usage unique)", headport="w") >> db
    create >> step(3, "AdminCreateUser\n(sans e-mail) + groupe eleve") >> cog
    create >> step(4, "lien /activer#token=…\n(affiché une fois)") >> parent
    parent >> step(5, "transmet le lien\n(hors AWS)", style="dotted") >> kid
    kid >> step(6, "ouvre le lien") >> cdn
    kid >> step(7, "POST /activation\n(jeton + mot de passe)") >> api
    api >> step(7) >> act
    act >> step(8, "consomme le jeton", headport="w") >> db
    act >> step(9, "AdminSetUserPassword") >> cog
    kid >> step(10, "connexion (SRP)") >> cog
