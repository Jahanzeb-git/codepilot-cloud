"""
/app/auth/api/auth.py
Author: Jahanzeb Ahmed <jahanzebahmed.mail@gmail.com>
Description: This file handles routing for authorization and authentication.
Licensed: MIT
"""
# --IMPORTS--
from fastapi import APIRouter, Depends, status, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from schemas.schemas import UserCreate
from db.database import get_db_session
from crud.repository import create_user, is_exists
from core.security import get_pass_hash, create_access_token

# --CONFIG--
router = APIRouter(prefix="/auth")

# --ENDPOINTS--
@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    payload: UserCreate, 
    db: AsyncSession = Depends(get_db_session)
    ):
    data = payload.model_dump()
    hashed_pass = get_pass_hash(data["password"])
    new_user = await create_user(db, data["email"], hashed_pass)
    return {"Status": "success", "email": new_user.email}


@router.post("/login")
async def login(
    request: Request,
    db: AsyncSession = Depends(get_db_session)
    ):
    content_type = request.headers.get("content-type", "")
    username = None
    password = None

    if "application/json" in content_type:
        try:
            body = await request.json()
            username = body.get("username") or body.get("email")
            password = body.get("password")
        except Exception:
            pass
    else:
        try:
            form = await request.form()
            username = form.get("username") or form.get("email")
            password = form.get("password")
        except Exception:
            pass

    if not username or not password:
        raise HTTPException(
            status_code=422,
            detail="Missing email/username or password"
        )

    if await is_exists(db, username, password):
        token = create_access_token(username)
        return {"access_token": token, "token_type": "bearer"}
    else: 
        raise HTTPException(
            status_code=401, 
            detail="Incorrect credentials"
        )

# --END OF FILE--

