"""Pydantic result models for Phase 4 enrichment operations."""

from pydantic import BaseModel, ConfigDict

__all__ = ["MetricsResult", "TopicResult"]


class MetricsResult(BaseModel):
    """Result of graph metrics computation via Neo4j GDS."""

    model_config = ConfigDict(frozen=True)

    narrators_enriched: int
    betweenness_computed: bool
    pagerank_computed: bool
    louvain_computed: bool
    degree_computed: bool
    communities_found: int


class TopicResult(BaseModel):
    """Result of zero-shot topic classification on hadith matn text."""

    model_config = ConfigDict(frozen=True)

    hadiths_classified: int
    hadiths_skipped: int
    model_name: str
    labels_used: list[str]
