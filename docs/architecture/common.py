"""Éléments communs des schémas d'architecture QCMonster (bibliothèque `diagrams`, icônes AWS).

Chaque schéma NN_*.py importe ce module, décrit ses noeuds et ses flèches numérotées, puis écrit
NN_*.png et NN_*.svg à côté de lui. Voir README.md pour la procédure de génération.
Aucun identifiant réel (compte, pool, URL) n'apparaît ici: on écrit <ID_COMPTE>, <POOL>, etc.
"""
from __future__ import annotations

from pathlib import Path

from diagrams import Cluster, Diagram, Edge

HERE = Path(__file__).resolve().parent


# Couleurs du standard AWS (groupes) et des flèches.
AWS_DARK = "#232F3E"
REGION_BLUE = "#00A4A6"
FLOW = "#C7254E"  # flèches numérotées
SOFT = "#7D8998"  # flèches secondaires (journaux, alarmes, lectures)

GRAPH = {
    "fontsize": "22",
    "fontname": "DejaVu Sans",
    "labelloc": "t",
    "pad": "0.5",
    "nodesep": "1.0",
    "ranksep": "1.6",
    "bgcolor": "white",
    "splines": "spline",
}
NODE = {"fontsize": "15", "fontname": "DejaVu Sans", "labelloc": "b"}
EDGE = {"fontname": "DejaVu Sans", "fontsize": "14"}


def diagram(name: str, title: str, direction: str = "LR"):
    """Ouvre un schéma qui écrit <name>.png et <name>.svg dans docs/architecture."""
    return Diagram(
        title,
        filename=str(HERE / name),
        outformat=["png", "svg"],
        show=False,
        direction=direction,
        graph_attr=GRAPH,
        node_attr=NODE,
        edge_attr=EDGE,
    )


def _cluster(label: str, color: str, style: str, bg: str = "white", fontcolor: str | None = None, just: str = "l"):
    return Cluster(
        label,
        graph_attr={
            "style": style,
            "color": color,
            "bgcolor": bg,
            "pencolor": color,
            "fontcolor": fontcolor or color,
            "fontsize": "17",
            "fontname": "DejaVu Sans",
            "labeljust": just,
            "margin": "36",
        },
    )


def aws_account():
    """Groupe « Compte AWS » (trait plein sombre), standard AWS Cloud."""
    return _cluster("Compte AWS <ID_COMPTE>", AWS_DARK, "solid", fontcolor=AWS_DARK)


def region():
    """Groupe « Région » (trait pointillé turquoise), standard AWS."""
    return _cluster("Région eu-west-3 (Paris)", REGION_BLUE, "dashed", bg="#F4FBFB", just="r")


def group(label: str, color: str = SOFT, bg: str = "#FAFAFA"):
    """Sous-groupe neutre (par ex. une pile CDK)."""
    return _cluster(label, color, "dotted", bg=bg)


def step(n: int, text: str = "", *, style: str = "solid", color: str = FLOW, **kw) -> Edge:
    """Flèche numérotée ((1), (2) ...) avec un court libellé optionnel."""
    label = f"({n})" + (f" {text}" if text else "")
    return Edge(label=label, color=color, fontcolor=color, style=style, penwidth="2.2", fontsize="16", **kw)


def plain(text: str = "", *, style: str = "dashed", color: str = SOFT, **kw) -> Edge:
    """Flèche secondaire, non numérotée."""
    return Edge(label=text, color=color, fontcolor=color, style=style, penwidth="1.4", **kw)
