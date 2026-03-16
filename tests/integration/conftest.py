"""Integration test fixtures using testcontainers."""

from __future__ import annotations

import pytest
from testcontainers.neo4j import Neo4jContainer
from testcontainers.postgres import PostgresContainer

from src.utils.neo4j_client import Neo4jClient


@pytest.fixture(scope="session")
def neo4j_container():
    """Start a real Neo4j container for integration tests."""
    with Neo4jContainer("neo4j:5-community") as neo4j:
        yield neo4j


@pytest.fixture
def neo4j_client(neo4j_container):
    """Neo4jClient connected to the test container."""
    client = Neo4jClient(
        uri=neo4j_container.get_connection_url(),
        user="neo4j",
        password="test",
    )
    yield client
    # Clean up: delete all nodes after each test
    client.execute_write("MATCH (n) DETACH DELETE n")
    client.close()


@pytest.fixture(scope="session")
def postgres_container():
    """Start a real PostgreSQL container."""
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        yield pg
