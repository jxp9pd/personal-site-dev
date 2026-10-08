"""Cloud response fixtures shared by board transport and HTTP integration tests."""
import io


def message():
    return [[1] + [0] * 14, [0] * 15, [0] * 15]


class Response(io.BytesIO):
    status = 200
