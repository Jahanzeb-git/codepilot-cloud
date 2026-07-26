import datetime
from authlib.jose import jwt

ALGORITHM = "HS256"
SECRET_KEY = "testsecret"

def test_jwt():
    header = {"alg": ALGORITHM}
    payload = {
        "sub": "test@test.com",
        "type": "connect_ticket",
        "exp": datetime.datetime.utcnow() + datetime.timedelta(seconds=30)
    }
    try:
        _token_bytes = jwt.encode(header, payload, SECRET_KEY)
        token = _token_bytes.decode('utf-8')
        print("Token:", token)
        claims = jwt.decode(token, SECRET_KEY)
        claims.validate()
        print("Valid!")
    except Exception as e:
        print("Error:", type(e), e)

test_jwt()
