"""
repository.py
Author: Jahanzeb Ahmed <jahanzebahmed.mail@gmail.com>
Description: This file handles utilities for authentication and authorization.
Licensed: MIT
"""
# --IMPORTS--
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from models.models import UserDB, MachineDB
from fastapi import HTTPException 
from core.security import verify_pass
from datetime import datetime, timezone

# --UTILITIES--
async def create_user(db: AsyncSession, email: str, hashed_password: str):
    """Create user and register in database"""
    new_user = UserDB(email=email, hashed_password=hashed_password)
    db.add(new_user)
    try:
        await db.commit()
        await db.refresh(new_user)
        return new_user
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="User already exists")


async def get_user_by_email(db: AsyncSession, email: str):
    """Get current user by email from database"""
    query = select(UserDB).where(UserDB.email == email)
    result = await db.execute(query)
    return result.scalar_one_or_none()

async def is_exists(db: AsyncSession, email: str, password: str) -> bool:
    """Check if user exists in database and password is correct"""
    query = select(UserDB).where(UserDB.email == email)
    exec = await db.execute(query)
    result = exec.scalar_one_or_none()
    if result and verify_pass(password, result.hashed_password):
        return True
    return False

async def add_machine(db: AsyncSession, machine_id: str, id: int, status: str, machine_secret: str) -> bool: 
    try:
        new_machine = MachineDB(user_id=id, fly_machine_id=machine_id, status=status, machine_secret=machine_secret)
        db.add(new_machine)
        await db.commit()
        await db.refresh(new_machine)
        return new_machine
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Machine already exists"
        )

async def is_machine_exists(db: AsyncSession, id: int):
    query = select(MachineDB).where(MachineDB.user_id == id)
    exec = await db.execute(query)
    machine = exec.scalar_one_or_none()
    if not machine:
        return None
    return machine

async def get_machine_by_secret(db: AsyncSession, x_machine_secret: str):
    # Guard against empty or missing secret (e.g. from a tombstoned/deleted machine)
    if not x_machine_secret:
        return None
    query = select(MachineDB).where(MachineDB.machine_secret == x_machine_secret)
    exec = await db.execute(query)
    machine = exec.scalar_one_or_none()
    if not machine:
        return None
    return machine
    
async def delete_machine_record(db: AsyncSession, machine: MachineDB):
    """Soft-delete a machine record by clearing the Fly machine ID and secret.

    The DB row is intentionally PRESERVED so that quota counters
    (daily_usage_seconds, total_usage_seconds) survive machine deletion.
    This prevents the delete-and-recreate quota bypass: a user cannot
    reset their usage by deleting their machine and launching a new one.

    The next /launch call will detect the tombstoned row (fly_machine_id=None)
    and reuse it with a fresh machine ID and secret.
    """
    machine.fly_machine_id = None
    machine.machine_secret = None        # None — no longer valid for auth
    machine.status = "stopped"
    machine.last_started_at = None
    await db.commit()

async def check_and_reset_daily_quota(db: AsyncSession, machine: MachineDB):
    """Reset daily usage if today is a new day."""
    today = datetime.now(timezone.utc).date()
    if machine.last_usage_date != today:
        machine.daily_usage_seconds = 0
        machine.last_usage_date = today
        await db.commit()

async def update_usage_on_suspend(db: AsyncSession, machine: MachineDB):
    """Calculate elapsed time since last_started_at and add to accumulators."""
    if machine.last_started_at:
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        elapsed = int((now - machine.last_started_at).total_seconds())
        if elapsed > 0:
            machine.daily_usage_seconds += elapsed
            machine.total_usage_seconds += elapsed
        machine.last_started_at = None
        await db.commit()

# --END OF FILE--