from diagrams.aws.database import Dynamodb
from diagrams.aws.devtools import Codebuild
from diagrams.aws.general import User
from diagrams.aws.management import Cloudformation
from diagrams.aws.network import CloudFront
from diagrams.aws.security import IAMRole
from diagrams.aws.storage import S3
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.vcs import Github

from common import aws_account, diagram, plain, region, step

with diagram("07_cicd", "Parcours 7: déploiement (GitHub Actions, OIDC, CDK)") as _:
    owner = User("Propriétaire")
    gh = Github("GitHub\n(repo public, main)")
    ga = GithubActions("GitHub Actions\nci puis deploy-dev\n(environnement dev)")
    with aws_account():
        deploy = IAMRole("Rôle de déploiement\n(OIDC, sans clé d'accès)")
        boot = IAMRole("Rôles du bootstrap CDK\n(deploy, file-publishing)")
        with region():
            cfn = Cloudformation("CloudFormation\n(9 stacks + web-content)")
            site = S3("S3 front (privé)")
            cdn = CloudFront("CloudFront\n(invalidation)")
            db = Dynamodb("DynamoDB")

    owner >> step(1, "fusionne la PR\n(CI verte)") >> gh
    gh >> step(2, "push sur main") >> ga
    ga >> step(3, "jeton OIDC\n(sub = repo + environnement)") >> deploy
    deploy >> step(4, "AssumeRole") >> boot
    ga >> step(5, "cdk deploy --all\n(-c bedrock=real)") >> boot
    boot >> step(6, "crée / met à jour") >> cfn
    ga >> step(7, "sorties CDK → build du front\n(API + ids Cognito publics)") >> ga
    ga >> step(8, "cdk deploy web-content") >> boot
    boot >> step(9, "BucketDeployment") >> site
    boot >> step(9, "invalide le cache") >> cdn
    owner >> plain("prod: lancement manuel\n(workflow_dispatch, après dev)") >> ga
    ga >> plain("script local (manuel):\ncreate-invite.ts, PutItem INVITE#*", style="dotted") >> db
