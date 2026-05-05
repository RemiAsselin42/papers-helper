#!/bin/bash

set -e

FAILED=0
PASSED=0

cd "$(dirname "$0")"

echo "Running tests..."

# Frontend
echo ""
echo "=== Frontend Lint ==="
cd frontend
if pnpm lint; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Frontend Type Check ==="
if pnpm typecheck; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Frontend Tests ==="
if pnpm test; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

cd ..

# Backend
echo ""
echo "=== Backend Lint ==="
cd backend
if uv run ruff check .; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

if uv run ruff format --check .; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Backend Type Check ==="
if uv run mypy app/; then
  PASSED=$((PASSED + 1))
else
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Backend Tests ==="
if timeout 30 uv run pytest tests/ -v -x --tb=short 2>&1; then
  PASSED=$((PASSED + 1))
else
  PYTEST_EXIT=$?
  if [ $PYTEST_EXIT -eq 124 ]; then
    echo "⚠️  Tests timed out after 30s (likely hanging)"
  fi
  FAILED=$((FAILED + 1))
fi

cd ..

echo ""
echo "=========================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "=========================================="

if [ $FAILED -gt 0 ]; then
  exit 1
fi
