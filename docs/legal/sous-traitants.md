# Sous-traitants

## AWS (Amazon Web Services)

- **Rôle** : sous-traitant d'hébergement et d'inférence. Stockage, calcul, authentification (Cognito), base de données, machines à états, modèles d'IA (Amazon Bedrock).
- **Localisation** : stockage à Paris. Les modèles d'IA sont appelés par des profils d'inférence de l'UE : l'analyse peut se faire dans une autre région de l'UE que Paris. Liste des régions de destination à relever au lot 1.
- **Contrat** : conditions d'AWS, dont l'accord de traitement des données (DPA). *Non relu pour ce document.*

## Fondation Wikimedia (Wikipédia, Wikibooks, Wikiversité, Vikidia)

- **Rôle** : destinataire, pas sous-traitant. Pour vérifier un fait, l'application interroge ces sites publics avec au plus 8 mots tirés de l'affirmation du cours. Aucun identifiant, pseudo, nom de famille ni jeton n'est envoyé. Les adresses de contact sont celles de l'application, jamais celles d'un élève ou d'un parent.
- **Risque** : si le cours contient un nom de personne, ce nom peut faire partie des 8 mots. Voir l'AIPD (§4).
- **Localisation** : serveurs de la Fondation (hors de l'UE possible). *Pas de contrat: services publics ouverts.*

## Le fournisseur du modèle a-t-il accès aux données ?

Source relue le 2026-11-24 : [Amazon Bedrock, Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)

Phrase exacte (en anglais) :

> Because the model providers don't have access to those accounts, they don't have access to Amazon Bedrock logs or to customer prompts and completions.

La page explique aussi que chaque région a un « Model Deployment Account » par fournisseur de modèle, détenu et exploité par l'équipe du service Bedrock, et que « Model providers don't have any access to those accounts ».

**Conclusion** : selon la documentation d'AWS, le fournisseur du modèle n'a pas accès aux logs ni aux prompts et réponses des clients. Le fournisseur du modèle n'est donc pas cité comme sous-traitant dans la politique. AWS est le seul sous-traitant.

## Détection d'abus de Bedrock

Source relue le 2026-11-26 : [Amazon Bedrock abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html). Bedrock peut utiliser une détection automatique d'abus et, « dans des circonstances limitées », conserver ou examiner des entrées et sorties. La page cite deux cas : certains modèles précis (OpenAI hors gpt-oss ; Claude Fable 5, 5.1 et 5.2), dont le trafic est conservé jusqu'à 30 jours, et la détection de contenus pédopornographiques dans les **images** (blocage possible, conservation et examen de l'image concernée, signalement possible à une autorité). Les modèles utilisés par QCMonster (Claude Haiku 5.5 et Sonnet 5.5, profils d'inférence UE) ne sont pas dans la liste de la page, donc le cas général s'applique ; le cas des images reste possible pour toute photo de cours. Les données restent chez AWS et ne sont pas partagées avec le fournisseur du modèle. À revérifier à chaque changement de modèle.

## Limites de cette relecture
- La page de conservation des données (`data-retention`) citée par la page d'abus n'a pas été lue.
- La facturation du modèle passe par AWS Marketplace d'après sa fiche. L'effet sur l'accès aux données **n'a pas** été vérifié.
- Le DPA d'AWS et la FAQ « Data Privacy » n'ont pas été relus.
- Ce document n'est pas un avis juridique.
