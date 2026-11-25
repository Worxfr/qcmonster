from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import User, InternetAlt1
from diagrams.aws.integration import Eventbridge, StepFunctions
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import APIGateway
from diagrams.aws.storage import S3

from common import aws_account, diagram, plain, region, step

with diagram("04_scan", "Parcours 4: scan d'un cours, vérification et génération de la fiche") as _:
    kid = User("Élève")
    wiki = InternetAlt1("Wikipédia, Wikilivres,\nWikiversité, Vikidia")
    with aws_account():
        with region():
            api = APIGateway("API Gateway HTTP")
            scan = Lambda("API des scans\nscans-create, jobs-*")
            photos = S3("S3 photos\n(scans/<sid>/<job>/<n>)")
            ev = Eventbridge("EventBridge\nObject Created")
            sfn = StepFunctions("Step Functions\n(attente d'envoi, confirmation)")
            steps = Lambda("Étapes\ncontrôle, transcription,\nextraction, quota, génération")
            ver = Lambda("verify-run\n(passages, jugement)")
            bed = Bedrock("Bedrock (profils UE)\nHaiku: lit et génère\nSonnet: juge")
            db = Dynamodb("DynamoDB\nJOB#, DOC#, COST#\n(compteur de coût)")

    kid >> step(1, "POST /scans\n(nb de pages)") >> api
    api >> step(1) >> scan
    scan >> step(2, "garde de coût (COST#),\nquota, job créé") >> db
    scan >> step(3, "démarre la machine") >> sfn
    kid >> step(4, "photo (POST pré-signé,\n5 Mo, 15 min)") >> photos
    photos >> step(5, "événement") >> ev
    ev >> step(5, "scan-start:\nreprend la machine") >> steps
    sfn >> step(6, "contrôle du fichier,\ntranscription") >> steps
    steps >> step(7, "Haiku (vision)") >> bed
    kid >> step(8, "lit, corrige,\nconfirme") >> api
    scan >> step(9, "reprend la machine,\nsupprime la photo") >> photos
    sfn >> step(10, "extraction, puis\nvérification") >> ver
    ver >> step(11, "recherche\nde passages") >> wiki
    ver >> step(12, "juge (Sonnet)") >> bed
    steps >> step(13, "fiche, QCM, trous,\nquota consommé, coût") >> db
