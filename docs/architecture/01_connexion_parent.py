from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import User
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.security import Cognito

from common import aws_account, diagram, plain, region, step

with diagram("01_connexion_parent", "Parcours 1: connexion du parent et création de la famille") as _:
    parent = User("Parent\n(navigateur)")
    with aws_account():
        with region():
            cdn = CloudFront("CloudFront + S3\n(site statique)")
            cog = Cognito("Cognito\n(client Web, SRP,\ngroupes parent/eleve/admin)")
            api = APIGateway("API Gateway HTTP\n(autorisateur JWT)")
            me = Lambda("me-get\n(GET /me)")
            fam = Lambda("family-create\n(POST /family)")
            db = Dynamodb("DynamoDB\nFAMILY#<fid>/META")

    parent >> step(1, "ouvre le site") >> cdn
    parent >> step(2, "connexion (SRP)\n→ jetons") >> cog
    parent >> step(3, "GET /me\n+ jeton ID") >> api
    api >> step(4, "vérifie le jeton\n(clés publiques)") >> cog
    api >> step(5) >> me
    me >> step(6, "lit la famille\n(404 si aucune)") >> db
    parent >> step(7, "POST /family\n(consentement)") >> api
    api >> step(7) >> fam
    fam >> step(8, "crée la famille") >> db
    fam >> step(9, "famille_id +\ngroupe parent") >> cog
    parent >> step(10, "renouvelle le jeton\n(refresh), puis GET /me = 200") >> cog
