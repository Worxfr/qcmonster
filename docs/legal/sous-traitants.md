# Sous-traitants

## AWS (Amazon Web Services)

- **Rôle** : sous-traitant d'hébergement et d'inférence. Stockage, calcul, authentification (Cognito), base de données, machines à états, modèles d'IA (Amazon Bedrock).
- **Localisation** : région de Paris pour l'hébergement ; modèles d'IA via profils d'inférence de l'UE.
- **Contrat** : conditions d'AWS, dont l'accord de traitement des données (DPA). *Non relu pour ce document.*

## Le fournisseur du modèle a-t-il accès aux données ?

Source relue le 2026-11-24 : [Amazon Bedrock, Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)

Phrase exacte (en anglais) :

> Because the model providers don't have access to those accounts, they don't have access to Amazon Bedrock logs or to customer prompts and completions.

La page explique aussi que chaque région a un « Model Deployment Account » par fournisseur de modèle, détenu et exploité par l'équipe du service Bedrock, et que « Model providers don't have any access to those accounts ».

**Conclusion** : selon la documentation d'AWS, le fournisseur du modèle n'a pas accès aux logs ni aux prompts et réponses des clients. Le fournisseur du modèle n'est donc pas cité comme sous-traitant dans la politique. AWS est le seul sous-traitant.

## Limites de cette relecture

- La même page renvoie à la détection d'abus de Bedrock (page `abuse-detection`). Cette page n'a **pas** été lue : à lire avant validation de l'AIPD.
- La facturation du modèle passe par AWS Marketplace d'après sa fiche. L'effet sur l'accès aux données **n'a pas** été vérifié.
- Le DPA d'AWS et la FAQ « Data Privacy » n'ont pas été relus.
- Ce document n'est pas un avis juridique.
