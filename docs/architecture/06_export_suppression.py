from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import User
from diagrams.aws.network import APIGateway
from diagrams.aws.security import Cognito
from diagrams.aws.storage import S3

from common import aws_account, diagram, region, step

with diagram("06_export_suppression", "Parcours 6: export et suppression des données de la famille") as _:
    parent = User("Parent")
    with aws_account():
        with region():
            api = APIGateway("API Gateway HTTP")
            adm = Lambda("family-admin\n(rôle « admin »)")
            db = Dynamodb("DynamoDB\nFAMILY#, STUDENT#\nDOC#, JOB#")
            cog = Cognito("Cognito\n(élèves et parent)")
            photos = S3("S3 photos\n(scans en cours)")

    parent >> step(1, "GET /family/export") >> api
    api >> step(1) >> adm
    adm >> step(2, "lit élèves, fiches,\nsignalements", tailport="e", headport="w") >> db
    adm >> step(3, "JSON complet\n(sans texte brut lu)") >> parent
    parent >> step(4, "DELETE /family") >> api
    adm >> step(5, "AdminDeleteUser\npour chaque élève", tailport="e") >> cog
    adm >> step(6, "supprime les photos\ndes traitements en cours", tailport="e") >> photos
    adm >> step(7, "efface tout l'arbre\n(sans PITR: immédiat)", tailport="e", headport="w") >> db
    adm >> step(8, "supprime le parent\nen dernier", tailport="e") >> cog
