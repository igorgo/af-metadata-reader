class Oci {
    constructor(user, pass, db) {
        this.db = require('oracle12db-win64')
        this.db.maxRows = 10000
        this.db.outFormat = this.db.OBJECT // {outFormat : oracledb.ARRAY}
        this.db.fetchAsString = [this.db.CLOB]
        this.db.poolMax = 10;
        return new Promise(resolve => {
            this.db.createPool({
                user: user,
                password: pass,
                connectString: db
            }).then((pool) => {
                this.pool = pool
                resolve(this)
            })
        })
    }

    async _createPool(user, pass, db) {
        return await this.db.createPool({
            user: user,
            password: pass,
            connectString: db
        })
    }

    async close() {
        await this.pool.close()
    }

    async execute(sql, binds) {
        const conn = await this.pool.getConnection()
        try {
            return await conn.execute(sql, binds)
        }
        finally {
            conn.close()
        }
    }

    async executeAndStayOpen(sql, binds) {
        const conn = await this.pool.getConnection()
        let result = await conn.execute(sql, binds)
        result.conn = conn
        return result
    }

}

module.exports = Oci