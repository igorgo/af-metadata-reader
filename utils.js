/**
 * Created by igorgo on 05.07.2017.
 */
let fs = require('fs-extra'),
    iconv = require('iconv-lite'),
    pd = require('pretty-data2').pd,
    conU = require('log-update')

class Utils {
    static async saveClob1251Xml(xml, path, filename) {
        fs.ensureDirSync(path)
        await fs.writeFile(`${path}/${filename}`, iconv.encode(pd.xml(xml), 'win1251'))
    }

    static async saveClob(clob, path, filename) {
        fs.ensureDirSync(path)
        await fs.writeFile(`${path}/${filename}`, clob)
    }

    static async saveBlob(lob, path, filename) {
        lob.on('error', (err) => {
            throw err
        })
        lob.on('end', () => {
        })
        lob.on('close', () => {
        })
        fs.ensureDirSync(path)
        let outStream = fs.createWriteStream(`${path}/${filename}`)
        outStream.on('error', (err) => {
            throw err
        })
        lob.pipe(outStream)

    }

    static conU(message) {
        conU(message)
    }

    static con(message) {
        process.stdout.write(message)
    }

    static conE(message) {
        process.stdout.write(message + '\n')
    }

    static coalesce(...values) {
        for (let i = 0; i < values.length; i++) {
            if (values[i] !== null && values[i] !== undefined) {
                return values[i]
            }
        }
        return null
    }

    static fixNum(n) {
        return n ? n.toFixed(0) : null
    }
}

module.exports = Utils