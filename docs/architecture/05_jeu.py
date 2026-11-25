from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import User
from diagrams.aws.network import APIGateway

from common import aws_account, diagram, region, step

with diagram("05_jeu", "Parcours 5: jeu (réponses, points, séries, badges, classement)") as _:
    kid = User("Élève")
    parent = User("Parent")
    with aws_account():
        with region():
            api = APIGateway("API Gateway HTTP")
            play = Lambda("Rôle « play »\nsession-get\nanswers-post\ndocs-mark-read")
            read = Lambda("Rôle « read »\nme-get, family-read")
            db = Dynamodb("DynamoDB\nDOC#, STUDENT#\nFAMILY#")

    kid >> step(1, "GET /docs/{id}/session") >> api
    api >> step(2) >> play
    play >> step(3, "questions sans la clé;\nouvre la série du jour", headport="w") >> db
    kid >> step(4, "POST /answers\n(question, choix)") >> api
    play >> step(5, "juge côté serveur;\nrègles anti-triche", headport="w") >> db
    play >> step(6, "XP (plafond 250/jour),\nbadges, +2 pages\ntous les 7 jours de série", headport="w") >> db
    parent >> step(7, "GET /family/leaderboard") >> api
    api >> step(7) >> read
    read >> step(8, "classement de la semaine\n(3 jours actifs minimum)", headport="w") >> db
