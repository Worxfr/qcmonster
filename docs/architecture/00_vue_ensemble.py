from diagrams.aws.compute import Lambda
from diagrams.aws.cost import Budgets
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import Users, InternetAlt1, User
from diagrams.aws.integration import Eventbridge, SNS, StepFunctions
from diagrams.aws.management import Cloudwatch, CloudwatchAlarm
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.security import Cognito
from diagrams.aws.storage import S3

from common import aws_account, diagram, group, plain, region, step

with diagram("00_vue_ensemble", "QCMonster: vue d'ensemble (env. dev, eu-west-3)") as _:
    user = Users("Parent ou élève\n(navigateur, PWA)")
    wiki = InternetAlt1("Wikipédia, Wikilivres,\nWikiversité, Vikidia\n(HTTPS, hors AWS)")
    owner = User("Propriétaire\n(e-mail d'alerte)")

    with aws_account():
        with region():
            with group("Site"):
                cdn = CloudFront("CloudFront\n(HTTPS, OAC)")
                web = S3("S3 front\n(privé)")
            cog = Cognito("Cognito\n(pool + groupes)")
            api = APIGateway("API Gateway HTTP\n(stage v1, JWT)")
            with group("Lambdas (Node 22, arm64)"):
                verify = Lambda("verify-run\n(vérif. des sources)")
                steps = Lambda("Étapes du scan\n(10 fonctions)")
                scan = Lambda("API des scans\n(8 fonctions)")
                game = Lambda("Jeu, famille, admin\n(14 fonctions)")
            sfn = StepFunctions("Step Functions\n(machine Standard)")
            ev = Eventbridge("EventBridge\n(règle scan-uploaded)")
            photos = S3("S3 photos\n(supprimées, 1 jour max)")
            db = Dynamodb("DynamoDB\n(table unique + COST#)")
            bed = Bedrock("Bedrock\nprofils UE Haiku et Sonnet")
            with group("Surveillance du coût"):
                alarm = CloudwatchAlarm("Alarme\n10 €/mois")
                sns = SNS("SNS\n(e-mail)")
                bud = Budgets("AWS Budgets\n(prod: 20, 25, 40 €)")
                logs = Cloudwatch("CloudWatch\n(journaux 14 jours)")

    user >> step(1, "site") >> cdn
    cdn >> plain("origine OAC", style="solid") >> web
    user >> step(2, "connexion") >> cog
    user >> step(3, "API") >> api
    api >> step(4) >> [game, scan]
    game >> step(5) >> db
    scan >> step(5) >> db
    scan >> step(6, "démarre") >> sfn
    user >> step(7, "photo\n(POST pré-signé)") >> photos
    photos >> step(8, "événement") >> ev
    ev >> step(8) >> steps
    sfn >> step(9, "orchestre") >> steps
    sfn >> step(9) >> verify
    steps >> step(10, "lit la photo,\ntranscrit") >> bed
    verify >> step(10, "juge") >> bed
    verify >> step(11, "cherche\ndes passages") >> wiki
    steps >> step(12, "coût") >> db
    db >> plain("COST# mensuel\n(métrique non publiée:\nvoir écarts)") >> alarm
    alarm >> step(13, "≥ 10 €") >> sns >> step(13) >> owner
    bud >> plain("prod: 40 € =\nIAM Deny Bedrock") >> steps
    steps >> plain("journaux") >> logs
